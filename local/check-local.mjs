// End-to-end check of the all-local setup, using Debrief's own code: a short piece of audio goes through the local
// Whisper server (speech to text), and the transcript goes through Ollama (the minutes). Nothing leaves this computer.
//
//   node local/check-local.mjs [audio.wav] [--model qwen2.5:7b] [--seconds 60] [--start 0] [--full]
//
// The audio must be a 16 kHz mono WAV (a recording converted with ffmpeg: ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav).
// Without a file it uses a spoken test sentence if the Whisper server can make one; otherwise it asks for a file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => import(pathToFileURL(path.join(here, '..', 'src', f)).href);
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const file = args.find((a) => !a.startsWith('--') && /\.wav$/i.test(a));
const model = flag('model', 'qwen2.5:7b');
const seconds = Number(flag('seconds', 60));
const start = Number(flag('start', 0));
const sttOnly = args.includes('--stt-only'); // skip the minutes (faster)
const full = args.includes('--full'); // thorough minutes (several model calls) instead of one quick pass
const say = (...x) => console.log(...x);

const { encodeWav } = await src('wav.js');
const { transcribe } = await src('stt.js');
const { writeMinutes } = await src('minutes.js');
const { generate } = await src('llm.js');
const { DEFAULTS } = await src('store.js');
const { listOllamaModels, ollamaContext, OLLAMA_BASE, WHISPER_BASE } = await src('local.js');

const settings = {
  ...DEFAULTS,
  sttProvider: 'openai',
  sttBase: WHISPER_BASE,
  sttModel: flag('stt-model', 'auto'),
  llmProvider: 'openai',
  oaBase: OLLAMA_BASE,
  oaModel: model,
  oaKey: '',
  momLanguage: 'English',
  minutesMode: full ? 'thorough' : 'quick',
  minutesFormat: 'standard',
  meetingLanguages: (flag('languages', 'en,hi') || '').split(',').filter(Boolean),
  learnedNames: [],
};

let failed = 0;
const step = (ok, title, detail = '') => {
  say(`${ok ? '✓' : '✗'} ${title}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

// 1. the two local services
try {
  const h = await (await fetch('http://127.0.0.1:8000/health')).json();
  step(!!h.ok, 'Whisper server', `reachable; models ${Object.entries(h.models).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
} catch (e) {
  step(false, 'Whisper server', `not reachable on port 8000 (${e.message}). Run local/start-local.bat first.`);
}
try {
  const list = await listOllamaModels();
  const names = list.ok ? list.models.map((m) => m.name) : [];
  step(list.ok && names.includes(model), 'Ollama', list.ok ? `reachable; models ${names.join(', ')}${names.includes(model) ? '' : `. "${model}" is missing: ollama pull ${model}`}` : list.message);
  const ctx = list.ok ? await ollamaContext(model).catch(() => null) : null;
  if (ctx?.max) say(`   ${model} can read up to ${ctx.max} tokens; the length Ollama really uses is its OLLAMA_CONTEXT_LENGTH (start-local sets 16384). "ollama ps" shows it while a model is loaded.`);
} catch (e) {
  step(false, 'Ollama', `not reachable (${e.message}). Start Ollama, with OLLAMA_ORIGINS=chrome-extension://* for the extension.`);
}
if (failed) {
  say('\nFix the above, then run this again.');
  process.exit(1);
}

// 2. audio -> text
if (!file) {
  say('\nGive a 16 kHz mono WAV file to test with, for example: node local/check-local.mjs "my meeting.wav" --seconds 90');
  process.exit(0);
}
const buf = fs.readFileSync(file);
const dataAt = buf.indexOf(Buffer.from('data')) + 8;
const rate = buf.readUInt32LE(24);
const pcm16 = new Int16Array(buf.buffer, buf.byteOffset + dataAt + 2 * rate * start, Math.min(rate * seconds, (buf.length - dataAt) / 2 - rate * start));
const pcm = Float32Array.from(pcm16, (x) => x / 32768);
step(rate === 16000, 'Audio file', `${(pcm.length / rate).toFixed(0)} s from ${path.basename(file)} starting at ${start} s${rate === 16000 ? '' : ` (sample rate ${rate}: convert to 16000)`}`);
let t0 = Date.now();
let text = '';
try {
  text = await transcribe(encodeWav(pcm, rate), settings);
  const secs = (Date.now() - t0) / 1000;
  step(text.length > 20, 'Speech to text', `${secs.toFixed(0)} s for ${(pcm.length / rate).toFixed(0)} s of audio (${(secs / (pcm.length / rate)).toFixed(2)}x real time), ${text.length} characters`);
  say(`   “${text.slice(0, 220).replace(/\s+/g, ' ')}${text.length > 220 ? '…' : ''}”`);
} catch (e) {
  step(false, 'Speech to text', e.message);
}
if (!text) process.exit(1);
if (sttOnly) process.exit(failed ? 1 : 0);

// 3. text -> minutes
const meeting = { id: 'check', title: 'Local check', startedAt: Date.now() - pcm.length / rate * 1000, endedAt: Date.now(), segments: [{ t: 0, dur: pcm.length / rate, src: 'others', text }], errors: [], url: '' };
t0 = Date.now();
let tokens = 0;
try {
  const r = await writeMinutes({
    meeting,
    settings,
    notes: '',
    ctx: { entries: [], attendees: [] },
    gen: (system, user, onText, opts) => generate({ settings, system, user, onText: (d) => { tokens += d.length; onText?.(d); }, temperature: opts?.temperature }),
    onStatus: (s) => say(`   … ${s}`),
  });
  const secs = (Date.now() - t0) / 1000;
  step(r.mom.length > 200, 'Minutes', `${secs.toFixed(0)} s with ${model}, ${r.mom.length} characters, ${r.stats.calls} model call${r.stats.calls === 1 ? '' : 's'}`);
  const out = path.join(process.env.TEMP || '.', 'debrief-local-check-minutes.md');
  fs.writeFileSync(out, r.mom);
  say(`   written to ${out}`);
  say('\n' + r.mom.split('\n').slice(0, 14).join('\n'));
} catch (e) {
  step(false, 'Minutes', e.message);
}
say(failed ? '\nSomething failed: see the ✗ lines.' : '\nAll local steps worked.');
process.exit(failed ? 1 : 0);
