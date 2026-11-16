// Golden-set evaluation. Offline by default (scores files already in the set); --live runs the real pipeline.
//   node test/eval/run.mjs [--set dir] [--stage stt|minutes|all] [--live] [--out dir] [--baseline report.json]
//                          [--fail-under-f1 0.6] [--fail-over-wer 0.5]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wer, cer, scriptShare, matchItems, ownerAccuracy, dueAccuracy, timestampError } from './metrics.mjs';
import { parseMinutesItems } from './parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../src');

function parseArgs(argv) {
  const o = { set: path.join(here, 'sets/sample'), stage: 'all', live: false, out: path.join(here, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') o.live = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      o[k] = argv[++i];
    }
  }
  if (!['stt', 'minutes', 'all'].includes(o.stage)) fail(`--stage must be stt, minutes or all (got ${o.stage})`, 2);
  return o;
}
function fail(msg, code) { console.error(msg); process.exit(code); }
const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const segText = (segs) => [...segs].sort((a, b) => a.t - b.t).map((s) => s.text).join('\n');

// ---- live (real src modules behind an in-memory chrome stub) ----
async function liveSetup() {
  if (!process.env.GEMINI_API_KEY) fail('--live needs GEMINI_API_KEY in the environment (and optionally DEBRIEF_SETTINGS=path/to/settings.json).', 2);
  const mem = {};
  globalThis.chrome = { storage: { local: {
    get: async (keys) => { const l = keys == null ? Object.keys(mem) : [].concat(keys); return Object.fromEntries(l.filter((k) => k in mem).map((k) => [k, JSON.parse(JSON.stringify(mem[k]))])); },
    set: async (o) => Object.assign(mem, JSON.parse(JSON.stringify(o))),
    remove: async (k) => [].concat(k).forEach((x) => delete mem[x]),
  } } };
  try { await import('fake-indexeddb/auto'); } catch {}
  const imp = (f) => import(path.join(SRC, f));
  const [{ DEFAULTS }, { Chunker, SR, chunkSecs }, { transcribe }, { writeMinutes }, llm, { encodeWav }] = await Promise.all(['store.js', 'chunker.js', 'stt.js', 'minutes.js', 'llm.js', 'wav.js'].map(imp));
  const override = process.env.DEBRIEF_SETTINGS ? readJson(process.env.DEBRIEF_SETTINGS) : {};
  const settings = { ...DEFAULTS, geminiKey: process.env.GEMINI_API_KEY, ...override };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gen = async (system, user, onText, opts) => {
    for (let i = 0; ; i++) {
      try { return await llm.generate({ settings, system, user, onText: onText || (() => {}), temperature: opts?.temperature }); } catch (e) {
        if (i >= 3 || !llm.isRetryable(e)) throw e;
        await sleep([5, 15, 30][i] * 1000);
      }
    }
  };
  return { settings, Chunker, SR, chunkSecs, transcribe, writeMinutes, gen, encodeWav };
}

// 16-bit PCM mono 16 kHz WAV -> Float32Array
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('audio.wav is not a RIFF/WAV file');
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16 || fmt.ch !== 1 || fmt.rate !== 16000) throw new Error('audio.wav must be 16 kHz, mono, 16-bit PCM');
      const n = Math.min(size, buf.length - p - 8) >> 1, out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(p + 8 + i * 2) / 32768;
      return out;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('audio.wav has no data chunk');
}

async function liveStt(L, audioFile) {
  const pcm = decodeWav(fs.readFileSync(audioFile));
  const chunks = [];
  const ch = new L.Chunker('others', (_src, start, data) => chunks.push({ start, data }), L.chunkSecs(L.settings));
  for (let i = 0; i < pcm.length; i += 2048) ch.push(pcm.subarray(i, i + 2048));
  ch.flush();
  const segments = [];
  for (const c of chunks) {
    const text = await L.transcribe(L.encodeWav(c.data, L.SR), L.settings);
    if (text) segments.push({ t: Math.round(c.start), src: 'others', text });
  }
  return segments;
}

async function liveMinutes(L, meta, segments) {
  const meeting = { id: 'eval', title: meta.title || 'Meeting', startedAt: Date.now() - 3600e3, endedAt: Date.now(), segments, notes: meta.notes || '' };
  const r = await L.writeMinutes({ meeting, settings: L.settings, notes: meta.notes || '', ctx: { entries: [], attendees: meta.attendees || [] }, gen: L.gen });
  return r.mom;
}

// ---- scoring ----
function scoreStt(refText, segs) {
  const hyp = segText(segs);
  const w = wer(refText, hyp), c = cer(refText, hyp);
  return { wer: w.wer, sub: w.sub, del: w.del, ins: w.ins, refWords: w.refWords, cer: c.cer, cerEdits: c.edits, refChars: c.refChars, scriptRef: scriptShare(refText), scriptHyp: scriptShare(hyp) };
}
function scoreMinutes(refItems, md) {
  const hyp = parseMinutesItems(md), ref = parseMinutesItems(refItems);
  const a = matchItems(ref.actions, hyp.actions), d = matchItems(ref.decisions, hyp.decisions);
  const all = a.matched.concat(d.matched);
  const slim = (m) => ({ p: m.precision, r: m.recall, f1: m.f1, matched: m.matched.length, missed: m.missed.map((x) => x.text), extra: m.extra.map((x) => x.text), nRef: m.matched.length + m.missed.length, nHyp: m.matched.length + m.extra.length });
  const nRef = a.matched.length + a.missed.length + d.matched.length + d.missed.length, nHyp = all.length + a.extra.length + d.extra.length;
  const p = nHyp ? all.length / nHyp : 0, r = nRef ? all.length / nRef : 0;
  return { actions: slim(a), decisions: slim(d), matched: all.length, nRef, nHyp, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, owner: ownerAccuracy(a.matched), due: dueAccuracy(a.matched), ts: timestampError(all) };
}

const pct = (x) => (x == null ? '      -' : (x * 100).toFixed(1).padStart(7));
const f2 = (x) => (x == null ? '  -' : x.toFixed(2));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const ratio = (n, d) => (d ? n / d : null);

function totals(cases) {
  const s = cases.map((c) => c.stt).filter(Boolean), m = cases.map((c) => c.minutes).filter(Boolean);
  const t = { cases: cases.length, wer: null, cer: null, f1: null, precision: null, recall: null, ownerAccuracy: null, dueAccuracy: null, tsMeanErrSec: null };
  if (s.length) { t.wer = ratio(sum(s.map((x) => x.sub + x.del + x.ins)), sum(s.map((x) => x.refWords))); t.cer = ratio(sum(s.map((x) => x.cerEdits)), sum(s.map((x) => x.refChars))); }
  if (m.length) {
    const hit = sum(m.map((x) => x.matched)), nh = sum(m.map((x) => x.nHyp)), nr = sum(m.map((x) => x.nRef));
    t.precision = ratio(hit, nh); t.recall = ratio(hit, nr);
    t.f1 = t.precision + t.recall ? (2 * t.precision * t.recall) / (t.precision + t.recall) : 0;
    t.ownerAccuracy = ratio(sum(m.map((x) => x.owner.correct)), sum(m.map((x) => x.owner.total)));
    t.dueAccuracy = ratio(sum(m.map((x) => x.due.correct)), sum(m.map((x) => x.due.total)));
    const ts = m.map((x) => x.ts).filter((x) => x.n);
    t.tsMeanErrSec = ts.length ? sum(ts.map((x) => x.mean * x.n)) / sum(ts.map((x) => x.n)) : null;
  }
  return t;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(o.set)) fail(`Set directory not found: ${o.set}`, 2);
  const names = fs.readdirSync(o.set, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(o.set, d.name, 'case.json'))).map((d) => d.name).sort();
  if (!names.length) fail(`No cases (folders with case.json) in ${o.set}`, 2);
  const L = o.live ? await liveSetup() : null;
  const doStt = o.stage !== 'minutes', doMin = o.stage !== 'stt';
  const cases = [];

  for (const name of names) {
    const dir = path.join(o.set, name), meta = readJson(path.join(dir, 'case.json')), outDir = path.join(o.out, name);
    const rec = { case: name, languages: meta.languages || [], stt: null, minutes: null, notes: [] };
    let segments = readJson(path.join(dir, 'transcript.json'));
    try {
      if (L) fs.mkdirSync(outDir, { recursive: true });
      if (L && doStt) {
        const audio = path.join(dir, 'audio.wav');
        if (fs.existsSync(audio)) { segments = await liveStt(L, audio); fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify(segments, null, 2)); } else rec.notes.push('no audio.wav: scored the stored transcript.json');
      }
      const refText = readText(path.join(dir, 'reference.txt'));
      if (doStt && segments && refText) rec.stt = scoreStt(refText, segments);
      else if (doStt) rec.notes.push(!segments ? 'no transcript' : 'no reference.txt');

      let md = readText(path.join(dir, 'minutes.md'));
      if (L && doMin) {
        if (!segments) rec.notes.push('no transcript.json: cannot write minutes');
        else { md = await liveMinutes(L, meta, segments); fs.writeFileSync(path.join(outDir, 'minutes.md'), md); }
      }
      const refItems = readJson(path.join(dir, 'reference.items.json'));
      if (doMin && md && refItems) rec.minutes = scoreMinutes(refItems, md);
      else if (doMin) rec.notes.push(!md ? 'no minutes' : 'no reference.items.json');
    } catch (e) { rec.error = e.message; }
    cases.push(rec);
  }

  const tot = totals(cases);
  let git = null;
  try { git = execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  const report = { when: new Date().toISOString(), git, mode: o.live ? 'live' : 'offline', set: o.set, cases, totals: tot };
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(report, null, 2));

  const base = o.baseline ? readJson(o.baseline) : null;
  const bCase = (n) => base?.cases?.find((c) => c.case === n);
  const delta = (cur, old, scale = 100) => (cur == null || old == null ? '' : ` (${cur - old >= 0 ? '+' : ''}${((cur - old) * scale).toFixed(1)})`);
  const regs = [];

  console.log(`set ${o.set}  mode ${report.mode}  git ${git || '-'}${base ? `  baseline ${o.baseline}` : ''}`);
  console.log('case'.padEnd(22) + 'WER%'.padStart(7) + 'CER%'.padStart(7) + 'Dev%'.padStart(7) + ' |' + 'F1%'.padStart(7) + 'P%'.padStart(7) + 'R%'.padStart(7) + 'own%'.padStart(7) + 'due%'.padStart(7) + 'tsErr'.padStart(8));
  const secs = (x) => (x == null ? '-' : x.toFixed(1) + 's').padStart(8);
  const row = (n, s, m) => console.log(n.padEnd(22) + pct(s?.wer) + pct(s?.cer) + pct(s?.scriptHyp?.devanagari) + ' |' + pct(m?.f1) + pct(m?.p ?? m?.precision) + pct(m?.r ?? m?.recall) + pct(m?.owner?.accuracy ?? m?.ownerAccuracy) + pct(m?.due?.accuracy ?? m?.dueAccuracy) + secs(m?.ts?.mean ?? m?.tsMeanErrSec));
  for (const c of cases) {
    row(c.case, c.stt, c.minutes);
    if (c.error) console.log(`   ERROR ${c.error}`);
    for (const n of c.notes) console.log(`   note: ${n}`);
    if (c.minutes) for (const k of ['actions', 'decisions']) { for (const x of c.minutes[k].missed) console.log(`   missed ${k.slice(0, -1)}: ${x}`); for (const x of c.minutes[k].extra) console.log(`   extra ${k.slice(0, -1)}: ${x}`); }
    const b = bCase(c.case);
    if (b) {
      const dw = c.stt && b.stt ? c.stt.wer - b.stt.wer : 0, df = c.minutes && b.minutes ? c.minutes.f1 - b.minutes.f1 : 0;
      const bad = dw > 0.02 || df < -0.03;
      console.log(`   vs baseline: WER${delta(c.stt?.wer, b.stt?.wer)} F1${delta(c.minutes?.f1, b.minutes?.f1)}${bad ? '  REGRESSION' : ''}`);
      if (bad) regs.push(c.case);
    }
  }
  row('TOTAL', { wer: tot.wer, cer: tot.cer, scriptHyp: null }, tot);
  if (base?.totals) {
    const bad = (tot.wer != null && base.totals.wer != null && tot.wer - base.totals.wer > 0.02) || (tot.f1 != null && base.totals.f1 != null && tot.f1 - base.totals.f1 < -0.03);
    console.log(`   vs baseline: WER${delta(tot.wer, base.totals.wer)} F1${delta(tot.f1, base.totals.f1)}${bad ? '  REGRESSION' : ''}`);
  }
  if (regs.length) console.log(`regressions: ${regs.join(', ')}`);
  console.log(`report: ${path.join(o.out, 'report.json')}`);

  let code = 0;
  if (o.failUnderF1 != null && tot.f1 != null && tot.f1 < +o.failUnderF1) { console.log(`FAIL item F1 ${tot.f1.toFixed(3)} < ${o.failUnderF1}`); code = 1; }
  if (o.failOverWer != null && tot.wer != null && tot.wer > +o.failOverWer) { console.log(`FAIL WER ${tot.wer.toFixed(3)} > ${o.failOverWer}`); code = 1; }
  if (cases.some((c) => c.error)) code = code || 1;
  process.exitCode = code;
}
main().catch((e) => { console.error(e.stack || e); process.exit(1); });
