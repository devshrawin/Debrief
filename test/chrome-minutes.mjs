// Real Chrome: the minutes page extras (play a line of a kept recording, read a stretch again, tick actions, notes about the shared
// screen, the share confirmation, the .json download) and the Open actions page, with the popup link. Throwaway local servers
// stand in for the speech-to-text service; the mail relay is faked in the page. Usage: node test/chrome-minutes.mjs
// Env: CHROME (browser path), SHOTS=<dir> to write screenshots (light and dark, 1280 and 360 wide) into that folder.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderMinutes } from '../src/structured.js';
import { heldStatus } from '../src/guard.js';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.SHOTS || '';
const EXT = path.resolve('extension');
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-minutes-'));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---- fake speech-to-text: the answer depends on `sttMode` ----
let sttMode = 'ok';
let sttDelay = 0;
let sttCalls = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  req.resume();
  req.on('end', async () => {
    sttCalls++;
    if (sttDelay) await new Promise((r) => setTimeout(r, sttDelay));
    if (sttMode === '401') return res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid API key for the speech service' } }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'Fresh words one. Fresh words two.', segments: [{ start: 0.2, end: 1, text: 'Fresh words one.' }, { start: 2.4, end: 2.9, text: 'Fresh words two.' }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const out = proc.stdio[3];
const inp = proc.stdio[4];
let nextId = 1;
const pending = new Map();
const problems = [];
let buf = '';
inp.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs before the page's own scripts: records the mail relay calls (and answers them), the files the page downloads, and gives
// the page a stand-in for the relay so nothing leaves the machine.
const PRELUDE = `
  window.__relay = []; window.__files = []; window.__blobs = new Map();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (String(url).startsWith('https://script.google.com/')) {
      const body = JSON.parse(opts.body); window.__relay.push(body);
      return new Response(JSON.stringify({ ok: true, to: body.to, cc: body.cc ? body.cc.split(',') : [], bcc: body.bcc ? body.bcc.split(',') : [] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  const mk = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = mk(b); window.__blobs.set(u, b); return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) { const b = window.__blobs.get(this.href); window.__files.push({ name: this.download, blob: b }); } else click.call(this); };
`;

async function openPage(url, { width = 1280, height = 900, scheme = 'light', wait = 1500 } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(wait);
  const evaluate = async (expression, gesture = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const v = await evaluate(expr);
        if (v) return v;
      } catch {}
      await sleep(150);
    }
    return false;
  };
  const resize = (w, h = 900) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
  const media = (features, media = '') => send('Emulation.setEmulatedMedia', { media, features }, sessionId);
  const shot = async (name, { full = false } = {}) => {
    if (!SHOTS) return;
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }, sessionId);
    writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const close = () => send('Target.closeTarget', { targetId });
  return { targetId, sessionId, evaluate, waitFor, resize, media, shot, close };
}
// A meeting as stored (its lists may be inline or in chunks), read inside a page.
const READ = `async (id) => { const all = await chrome.storage.local.get(null); const meta = all['meeting:' + id]; const out = { ...meta }; for (const l of ['segments', 'gaps', 'screens']) { if (Array.isArray(meta[l])) continue; const p = meta.parts?.[l]; out[l] = p ? Array.from({ length: p.chunks }, (_, i) => all['mp:' + id + ':' + l + ':' + (p.first + i)] || []).flat() : []; } return out; }`;
let failed = false;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};

// ---- the data ----
const NOW = Date.now();
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const items1 = {
  overview: 'We reviewed the launch plan.', summary: ['On track'], topics: [],
  decisions: [{ text: 'Ship on Friday', at: '00:01' }], risks: [], questions: [], next: [],
  actions: [
    { id: 'act1', text: 'Run the load test', owner: 'Amal Raj', due: iso(NOW + 30 * DAY), at: '00:02', quote: 'run the test', status: 'open' },
    { id: 'act2', text: 'Send the budget sheet', owner: 'Priya Nair', due: 'Not stated', at: '', quote: '', status: 'done', doneAt: NOW - DAY },
    { id: 'act3', text: '<img src=x onerror=window.__x=1> and *stars*', owner: 'Team', due: 'Not stated', at: '00:01', quote: '', status: 'open' },
  ],
};
const mom1 = renderMinutes(items1, { meeting: { title: 'Weekly sync', startedAt: NOW - 3600000, endedAt: NOW - 1000 }, attendees: ['Amal Raj'] });
const mom2 = mom1.replace('Run the load test', 'Run the performance test'); // edited by hand: the rows no longer match the items
const row = (t, text, extra = {}) => ({ t, src: 'others', text, ...extra });
const segs1 = [row(0.4, 'Row A text.', { c: 0, dur: 3 }), row(1.5, 'Row B text.', { c: 0, dur: 3 }), row(2.2, 'Row C text.', { c: 0, dur: 3 }), row(30, 'Row D text.', { c: 30, dur: 30 }), row(60.3, 'Row E text.', { c: 60, dur: 30 })];
const screens1 = [{ t: 1, text: 'Slide: launch checklist', presenter: 'Priya Nair' }, { t: 1.2, text: 'slide: launch checklist', presenter: 'Priya Nair' }, { t: 45, text: 'A spreadsheet with three tabs' }];
const base = { startedAt: NOW - 3600000, endedAt: NOW - 1000, errors: [], emailedAt: 0 };
const meetings = {
  mn1: { ...base, id: 'mn1', title: 'Weekly sync', segments: segs1, screens: screens1, items: items1, mom: mom1, model: 'fake', carriedFrom: { id: 'mn0', title: 'Last week', at: NOW - 7 * DAY }, shareHeld: ['ravi@outside.org'], shareStatus: heldStatus(['ravi@outside.org']), webhookError: 'HTTP 500 from the endpoint', notice: { ok: false, posted: false, why: 'chat is closed', at: NOW - 5000 }, gaps: [{ t: 10, dur: 18, voicedSec: 15, chars: 0 }], voiceSegs: [{ t0: 1, t1: 2, e: [0.1, 0.2] }], format: 'standard' },
  mn2: { ...base, id: 'mn2', title: 'Edited minutes', segments: segs1.slice(0, 3), items: items1, mom: mom2, format: 'standard' },
  mn0: { ...base, id: 'mn0', title: 'Last week', startedAt: NOW - 7 * DAY, endedAt: NOW - 7 * DAY + 3000000, segments: [row(3, 'Old.')], mom: '# Last week', items: { ...items1, decisions: [], actions: [{ id: 'old1', text: 'Prepare the vendor list', owner: 'Priya Nair', due: iso(NOW - 10 * DAY), at: '03:10', quote: '', status: 'open' }, { id: 'old2', text: 'Book the room', owner: 'Not stated', due: 'Not stated', at: '', quote: '', status: 'open' }] } },
  mn3: { ...base, id: 'mn3', title: 'Budget review', startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + 2000000, segments: [row(3, 'Budget.')], mom: '# Budget review', items: { ...items1, decisions: [], actions: [{ id: 'b1', text: 'Send the revised budget', owner: 'Amal Raj', due: iso(NOW + 2 * DAY), at: '10:00', quote: '', status: 'open' }, { id: 'b2', text: 'Confirm headcount', owner: 'Team', due: iso(NOW + 40 * DAY), at: '', quote: '', status: 'open' }] } },
};
const forActions = { mn0: meetings.mn0, mn1: meetings.mn1, mn3: meetings.mn3 }; // not the one whose minutes were edited, which has the same actions as mn1
const settings = { llmProvider: 'openai', oaBase: `http://127.0.0.1:${PORT}/v1`, oaModel: 'fake', sttProvider: 'openai', sttBase: `http://127.0.0.1:${PORT}/v1`, sttModel: 'fake', minutesFormat: 'standard', calendarLookup: false, emailAuto: false, voiceOn: false, myName: 'Amal Raj', emailTo: 'me@acme.com', myOrgDomains: 'acme.com', emailWebhook: 'https://script.google.com/macros/s/TEST/exec', emailSecret: 'test', keepAudio: true };

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const opts = await openPage(`chrome-extension://${id}/options.html`, { wait: 1200 });
  const seed = async (list, s = settings) => {
    const rec = { settings: s, meetingIds: Object.keys(list) };
    for (const [k, m] of Object.entries(list)) rec[`meeting:${k}`] = m; // the old single-record shape, still read
    await opts.evaluate(`(async () => { const all = await chrome.storage.local.get(null); await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('meeting') || k.startsWith('mp:'))); await chrome.storage.local.set(${JSON.stringify(rec)}); })()`);
  };
  await seed(meetings);

  // real audio clips (a tone each, recorded in the page) stored the way the recorder stores them: seq 0..2 follow each other, seq 3 is after a hole
  const made = await opts.evaluate(`(async () => {
    if (typeof MediaRecorder === 'undefined') return 'no MediaRecorder';
    const clip = async (freq) => {
      const ac = new AudioContext(); const osc = ac.createOscillator(); osc.frequency.value = freq; const dest = ac.createMediaStreamDestination(); osc.connect(dest); osc.start();
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' }); const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r)); rec.start(); await new Promise((r) => setTimeout(r, 1000)); rec.stop(); await stopped; osc.stop(); ac.close();
      return new Blob(chunks, { type: 'audio/webm' });
    };
    const db = await new Promise((res, rej) => { const r = indexedDB.open('debrief-audio', 1); r.onupgradeneeded = () => { const s = r.result.createObjectStore('seg', { keyPath: ['meetingId', 'seq'] }); s.createIndex('meetingId', 'meetingId'); s.createIndex('savedAt', 'savedAt'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const put = (seg) => new Promise((res, rej) => { const t = db.transaction('seg', 'readwrite'); t.objectStore('seg').put(seg); t.oncomplete = res; t.onerror = () => rej(t.error); });
    for (const [seq, t0, f] of [[0, 0, 330], [1, 1, 440], [2, 2, 550], [3, 60, 660]]) {
      const blob = await clip(f);
      await put({ meetingId: 'mn1', seq, t0, dur: 1, blob, savedAt: Date.now() });
    }
    db.close(); return 'ok';
  })()`);
  check('real audio clips could be recorded for the test (MediaRecorder works in this Chrome)', made === 'ok', String(made));
  const haveAudio = made === 'ok';

  // ===== 1. the minutes page of a meeting with a kept recording =====
  const p1 = await openPage(`chrome-extension://${id}/mom.html?id=mn1`);
  await p1.evaluate(`document.getElementById('tabTr').click()`);
  const v1 = await p1.evaluate(`(() => ({
    rows: [...document.querySelectorAll('#transcript .seg')].map((r) => ({ cls: r.className, who: r.children[1].textContent, text: r.children[2].textContent, hasBtn: !!r.children[0].querySelector('button.seg-play'), label: r.children[0].querySelector('button')?.getAttribute('aria-label') || '', w: r.children[0].getBoundingClientRect().width, tt: r.children[0].textContent, pick: r.children[1].classList.contains('pick') })),
    keepHint: !document.getElementById('keepHint').classList.contains('hidden'),
  }))()`);
  const speech = v1.rows.filter((r) => /Row [A-E]/.test(r.text));
  check('every spoken line has its time as a play button named "Play from mm:ss"', speech.length === 5 && speech.every((r) => r.hasBtn) && speech[1].label === 'Play from 00:01' && speech[3].label === 'Play from 00:30', JSON.stringify(speech.map((r) => r.label)));
  check('the button shows just the time, and the time column is as wide on every row', v1.rows.every((r) => r.w === v1.rows[0].w) && speech[1].tt === '00:01', JSON.stringify(v1.rows.map((r) => r.w)));
  const screenRows = v1.rows.filter((r) => /screen/.test(r.cls));
  check('notes about the shared screen show in place, twice not three times, labelled "On screen", without a speaker menu', screenRows.length === 2 && screenRows.every((r) => r.who === 'On screen' && !r.pick) && /Priya Nair/.test(screenRows[0].text) && /launch checklist/.test(screenRows[0].text) && v1.rows.findIndex((r) => /screen/.test(r.cls)) === 1, JSON.stringify(screenRows));
  check('the gap shows a "Read this part again" button', await p1.evaluate(`!!document.querySelector('#transcript .rr-gap')`));
  check('with a kept recording no "turn it on" tip is shown', !v1.keepHint);

  if (haveAudio) {
    // play Row B (1.5 s): the stored segment seq 1 (starts at 1 s), offset 0.5 s
    await p1.evaluate(`document.querySelectorAll('#transcript .seg-play')[2].click()`, true);
    const bar = await p1.waitFor(`!document.getElementById('playBar').hidden && document.getElementById('momAudio').dataset.seq`);
    const a1 = await p1.evaluate(`({ seq: document.getElementById('momAudio').dataset.seq, off: document.getElementById('momAudio').dataset.offset, t0: document.getElementById('momAudio').dataset.t0, cur: [...document.querySelectorAll('#transcript .seg[aria-current]')].map((r) => r.children[2].textContent), time: document.querySelector('.pb-time').textContent, label: document.querySelector('.pb-play').getAttribute('aria-label') })`);
    check('the player bar opens on the right stored segment at the right offset (1.5 s is 0.5 s into the segment that starts at 1 s)', bar && a1.seq === '1' && a1.off === '0.5' && a1.t0 === '1', JSON.stringify(a1));
    check('the playing line is marked with aria-current', a1.cur.length === 1 && /Row B/.test(a1.cur[0]), JSON.stringify(a1.cur));
    await p1.shot('minutes-player-light-1280');
    const adv = await p1.waitFor(`document.getElementById('momAudio').dataset.seq === '2'`, 6000);
    check('it carries on into the next stored segment by itself', !!adv, await p1.evaluate(`JSON.stringify({ seq: document.getElementById('momAudio').dataset.seq, err: document.getElementById('momAudio').error?.message, paused: document.getElementById('momAudio').paused, t: document.getElementById('momAudio').currentTime })`));
    // a stretch with no recording
    await p1.evaluate(`document.querySelectorAll('#transcript .seg-play')[4].click()`, true);
    const missing = await p1.waitFor(`document.querySelector('.pb-msg').textContent`, 3000);
    check('a time with no kept recording says so in the player bar', missing === 'No recording was kept for this part.', String(missing));
    // back 10 s from 1.5 goes to 0
    await p1.evaluate(`document.querySelectorAll('#transcript .seg-play')[2].click()`, true);
    await p1.waitFor(`document.getElementById('momAudio').dataset.seq === '1'`);
    await p1.evaluate(`document.querySelector('.pb-back').click()`, true);
    check('"Back 10 s" goes back, to the start of the recording at most', await p1.waitFor(`document.getElementById('momAudio').dataset.seq === '0' && document.getElementById('momAudio').dataset.offset === '0'`, 4000));
    // times inside the minutes
    const tok = await p1.evaluate(`(() => { document.getElementById('tabMom').click(); const b = [...document.querySelectorAll('#mom .timebtn')]; return { n: b.length, labels: b.map((x) => x.getAttribute('aria-label')), text: b.map((x) => x.textContent), inA: b.every((x) => x.closest('li, td')) } })()`);
    check('[mm:ss] in the decisions and in the Source cells became play buttons (and only those)', tok.n === 3 && tok.text.every((t) => /^\[\d\d:\d\d\]$/.test(t)) && tok.labels.includes('Play from 00:02') && tok.inA, JSON.stringify(tok));
    await p1.evaluate(`[...document.querySelectorAll('#mom .timebtn')].find((b) => b.textContent === '[00:02]').click()`, true);
    check('a time in the minutes plays from there', await p1.waitFor(`document.getElementById('momAudio').dataset.seq === '2'`, 4000));
    // keep this bar open for the print check below
    await p1.shot('minutes-top-light-1280');
  }

  // ----- tick actions -----
  await p1.evaluate(`document.getElementById('tabMom').click()`);
  const act = await p1.evaluate(`(() => {
    const cbs = [...document.querySelectorAll('#mom td.act-cell input[type=checkbox]')];
    return { n: cbs.length, checked: cbs.map((c) => c.checked), names: cbs.map((c) => c.closest('label').textContent), summary: document.querySelector('#mom .act-summary')?.textContent, link: document.querySelector('#mom .act-summary a')?.getAttribute('href'), img: !!document.querySelector('#mom img'), x: window.__x, literal: document.getElementById('mom').textContent.includes('<img src=x onerror=window.__x=1>'), stars: document.getElementById('mom').textContent.includes('stars') };
  })()`);
  check('the Action Items table has one tick box per row, matching the items (the done one is ticked)', act.n === 3 && JSON.stringify(act.checked) === '[false,true,false]', JSON.stringify(act));
  check('each tick box has a real label "Mark done: <action>"', act.names[0] === 'Mark done: Run the load test', JSON.stringify(act.names));
  check('"N open · M done" with a link to the actions page sits above the table', /2 open · 1 done/.test(act.summary) && /All open actions/.test(act.summary) && act.link === 'actions.html', JSON.stringify(act.summary));
  check('an injected <img onerror> in an action stays inert and literal', !act.img && act.x === undefined && act.literal, JSON.stringify(act));
  const momBefore = await p1.evaluate(`chrome.storage.local.get('meeting:mn1').then((r) => r['meeting:mn1'].mom)`);
  await p1.evaluate(`document.querySelector('#mom td.act-cell input').click()`);
  await sleep(700);
  const after = await p1.evaluate(`(async () => { const m = (await chrome.storage.local.get('meeting:mn1'))['meeting:mn1']; return { st: m.items.actions.map((a) => a.status), doneAt: !!m.items.actions[0].doneAt, mom: m.mom, row: document.querySelector('#mom tr.act-done .act-text')?.textContent, summary: document.querySelector('#mom .act-count').textContent, live: document.getElementById('actLive').textContent, sr: document.querySelector('#mom tr.act-done .act-status')?.textContent }; })()`);
  check('ticking saves the action as done (with a time), and leaves the minutes text exactly as it was', JSON.stringify(after.st) === '["done","done","open"]' && after.doneAt && after.mom === momBefore, JSON.stringify(after.st));
  check('the row is struck through, says "(done)" to a screen reader, and the count and live line update', after.row === 'Run the load test' && after.sr === ' (done)' && /1 open · 2 done/.test(after.summary) && /Marked done: Run the load test/.test(after.live), JSON.stringify(after));
  await p1.evaluate(`document.querySelector('#mom td.act-cell input').click()`);
  await sleep(700);
  check('unticking puts it back', (await p1.evaluate(`chrome.storage.local.get('meeting:mn1').then((r) => r['meeting:mn1'].items.actions[0].status)`)) === 'open');
  await p1.evaluate(`document.querySelector('#mom td.act-cell input').click()`);
  await sleep(500);
  // a rename of the meeting (a full save of the page's copy) must not undo the tick
  await p1.evaluate(`(() => { const t = document.getElementById('title'); t.value = 'Weekly sync'; t.onchange(); })()`);
  await sleep(500);
  check('saving the page afterwards keeps the tick', (await p1.evaluate(`chrome.storage.local.get('meeting:mn1').then((r) => r['meeting:mn1'].items.actions[0].status)`)) === 'done');
  await p1.evaluate(`document.querySelector('#mom td.act-cell input').click()`);
  await sleep(500);

  // ----- carried line, warnings, held share -----
  const top = await p1.evaluate(`(() => ({ carried: document.getElementById('carried').textContent, href: document.querySelector('#carried a')?.getAttribute('href'), errors: [...document.querySelectorAll('#errors p')].map((p) => p.textContent), errHidden: document.getElementById('errors').classList.contains('hidden'), held: !document.getElementById('shareHeldNow').classList.contains('hidden'), open: document.getElementById('shareBox').open, status: document.getElementById('shareStatus').textContent }))()`);
  check('the carried-from line links to the earlier meeting', /^Reviews open actions from Last week, /.test(top.carried) && top.href === 'mom.html?id=mn0', JSON.stringify(top));
  check('the warning box has the gap, the other-tool error and the recording-notice failure, one line each', !top.errHidden && top.errors.length === 3 && /No transcript for/.test(top.errors[0]) && top.errors[1] === 'Could not send the minutes to your other tool: HTTP 500 from the endpoint' && top.errors[2] === 'The recording notice could not be posted in the meeting chat (chat is closed).', JSON.stringify(top.errors));
  check('the held share shows its status, opens the Share box and offers "Send to them now"', top.held && top.open && /Not sent automatically to people outside your organisation: ravi@outside.org/.test(top.status), JSON.stringify(top));

  // ----- share confirmation -----
  await p1.evaluate(`document.getElementById('shareHeldNow').click()`);
  check('"Send to them now" fills in the held addresses', (await p1.evaluate(`document.getElementById('shareTo').value`)) === 'ravi@outside.org');
  await p1.evaluate(`document.getElementById('shareTranscript').checked = true; document.getElementById('shareTranscript').onchange({ target: document.getElementById('shareTranscript') })`);
  await sleep(300);
  await p1.evaluate(`document.getElementById('shareSend').click()`);
  const dlg = await p1.waitFor(`document.querySelector('dialog.dbmodal')?.textContent`);
  check('sharing outside the organisation asks first, and says the transcript goes too', /ravi@outside\.org is outside your organisation\. Send anyway\? The transcript will be attached\./.test(dlg || ''), String(dlg));
  await p1.shot('minutes-share-confirm-light-1280');
  await p1.evaluate(`[...document.querySelectorAll('dialog.dbmodal button')].find((b) => b.textContent === 'Cancel').click()`);
  await sleep(500);
  const cancelled = await p1.evaluate(`({ calls: window.__relay.length, status: document.getElementById('shareStatus').textContent })`);
  check('Cancel sends nothing', cancelled.calls === 0 && cancelled.status === 'Not sent.', JSON.stringify(cancelled));
  await p1.evaluate(`document.getElementById('shareSend').click()`);
  await p1.waitFor(`document.querySelector('dialog.dbmodal')`);
  await p1.evaluate(`[...document.querySelectorAll('dialog.dbmodal button')].find((b) => b.textContent === 'Send').click()`);
  await p1.waitFor(`window.__relay.length === 1 && /Shared with/.test(document.getElementById('shareStatus').textContent)`);
  const sent = await p1.evaluate(`({ n: window.__relay.length, to: window.__relay[0]?.to, held: document.getElementById('shareHeldNow').classList.contains('hidden'), status: document.getElementById('shareStatus').textContent })`);
  check('Send goes out to that address, and it no longer shows as held', sent.n === 1 && sent.to === 'ravi@outside.org' && sent.held && /Shared with ravi@outside\.org/.test(sent.status), JSON.stringify(sent));
  await p1.evaluate(`document.getElementById('shareTo').value = 'colleague@acme.com'; document.getElementById('shareSend').click()`);
  await p1.waitFor(`window.__relay.length === 2`);
  check('an address inside the organisation goes out without a question', (await p1.evaluate(`!document.querySelector('dialog.dbmodal') && window.__relay[1].to === 'colleague@acme.com'`)));

  // ----- downloads: .txt with the screen notes, .json without voice fingerprints -----
  await p1.evaluate(`document.getElementById('tabTr').click(); document.getElementById('dlTxt').click()`);
  const txt = await p1.evaluate(`(async () => { const f = window.__files.at(-1); return { name: f.name, text: await f.blob.text() }; })()`);
  const tl = txt.text.split('\n');
  const at = tl.findIndex((l) => /ON SCREEN/.test(l));
  check('the .txt has the screen notes as "[mm:ss] ON SCREEN (name): …", in place, once each', tl.filter((l) => /ON SCREEN/.test(l)).length === 2 && tl[at] === '[00:01] ON SCREEN (Priya Nair): Slide: launch checklist' && /^\[00:01\] OTHERS: Row B/.test(tl[at + 1]) && /\[00:45\] ON SCREEN: A spreadsheet/.test(txt.text), txt.text);
  await p1.evaluate(`document.getElementById('dlJson').click()`);
  await p1.waitFor(`window.__files.length >= 2`);
  const js = await p1.evaluate(`(async () => { const f = window.__files.at(-1); return { name: f.name, text: await f.blob.text() }; })()`);
  let parsed = {};
  try { parsed = JSON.parse(js.text); } catch {}
  check('.json is named "<title>-<date>.json" and is the whole meeting without voice fingerprints', js.name === `Weekly sync-${iso(NOW - 3600000)}.json` && parsed.app === 'debrief' && parsed.meeting?.id === 'mn1' && !('voiceSegs' in (parsed.meeting || {})) && parsed.meeting?.segments?.length === 5 && parsed.meeting?.items?.actions?.length === 3, js.name + ' ' + js.text.slice(0, 120));

  // ----- read a stretch again -----
  if (haveAudio) {
    await p1.evaluate(`document.querySelectorAll('#transcript .seg-play')[2].click()`, true);
    await p1.waitFor(`!document.querySelector('.pb-again').hidden`);
    sttMode = '401';
    sttDelay = 900;
    await p1.evaluate(`document.querySelector('.pb-again').click()`, true);
    await sleep(250);
    const busy = await p1.evaluate(`({ disabled: document.querySelector('.pb-again').disabled, aria: document.querySelector('.pb-again').getAttribute('aria-busy'), replace: [...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Replace these lines').disabled })`);
    const err = await p1.waitFor(`document.querySelector('.rr-err:not(.hidden)')?.textContent`, 8000);
    sttDelay = 0;
    check('while a read is under way the button is busy and nothing can be replaced', busy.disabled && busy.aria === 'true' && busy.replace, JSON.stringify(busy));
    check('when the speech service refuses, the dialog shows its message and offers to try again', /Invalid API key for the speech service/.test(err || '') && (await p1.evaluate(`!![...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Try again' && !b.hidden)`)) && !(await p1.evaluate(`document.querySelector('.pb-again').disabled`)), String(err));
    check('the old lines are still shown and still stored', (await p1.evaluate(`document.querySelector('.rr-dialog .rr-col .rr-text').textContent`)).includes('Row B text.') && (await p1.evaluate(`(${READ})('mn1').then((m) => m.segments.length)`)) === 5);
    sttMode = 'ok';
    await p1.evaluate(`[...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Try again').click()`);
    const fresh = await p1.waitFor(`document.querySelectorAll('.rr-dialog .rr-text')[1].textContent.includes('Fresh words one.') && document.querySelectorAll('.rr-dialog .rr-text')[1].textContent`, 8000);
    check('"Try again" shows the new text next to the old', !!fresh && (await p1.evaluate(`document.querySelectorAll('.rr-dialog .rr-text')[0].textContent.includes('Row A text.')`)), String(fresh));
    await p1.shot('minutes-reread-light-1280');
    await p1.evaluate(`[...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Keep what I have').click()`);
    await sleep(300);
    check('"Keep what I have" changes nothing', (await p1.evaluate(`(${READ})('mn1').then((m) => m.segments.map((s) => s.text).join('|'))`)) === 'Row A text.|Row B text.|Row C text.|Row D text.|Row E text.' && !(await p1.evaluate(`document.querySelector('.rr-dialog')`)));
    await p1.evaluate(`document.querySelector('.pb-again').click()`, true);
    await p1.waitFor(`!document.querySelector('.rr-dialog .primary')?.disabled`, 8000);
    await p1.evaluate(`[...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Replace these lines').click()`);
    await sleep(900);
    const rep = await p1.evaluate(`(async () => { const m = await (${READ})('mn1'); return { texts: m.segments.map((s) => s.text), flags: m.segments.map((s) => !!s.reread), src: m.segments.map((s) => s.src), ts: m.segments.map((s) => s.t), rows: [...document.querySelectorAll('#transcript .seg')].map((r) => r.children[2].textContent.replace(/Read this part again/, '')), status: document.getElementById('genStatus').textContent, mom: m.mom === ${JSON.stringify(mom1)} }; })()`);
    check('"Replace these lines" swaps exactly the three lines of that piece, keeps the others in order, and marks the new ones', JSON.stringify(rep.texts) === JSON.stringify(['Fresh words one.', 'Fresh words two.', 'Row D text.', 'Row E text.']) && JSON.stringify(rep.flags) === '[true,true,false,false]' && rep.ts[0] === 0.2 && rep.ts[1] === 2.4 && rep.src.every((s) => s === 'others'), JSON.stringify(rep));
    check('the page shows the new lines and says to press Rewrite minutes; the minutes text itself is untouched', rep.rows.some((r) => /Fresh words two/.test(r)) && !rep.rows.some((r) => /Row B/.test(r)) && /Press Rewrite minutes to use the new text\./.test(rep.status) && rep.mom, JSON.stringify(rep.rows) + rep.status);
    // a gap that has no recording
    await p1.evaluate(`document.querySelector('#transcript .rr-gap').click()`);
    const gapErr = await p1.waitFor(`document.querySelector('.rr-err:not(.hidden)')?.textContent`, 6000);
    check('a gap with no kept recording says so, and nothing is lost', gapErr === 'No recording was kept for this part.' && (await p1.evaluate(`(${READ})('mn1').then((m) => m.segments.length)`)) === 4, String(gapErr));
    await p1.evaluate(`[...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Keep what I have').click()`);
    // close the player; print view
    check('the gap button is usable again after the dialog closes', await p1.evaluate(`!document.querySelector('#transcript .rr-gap').disabled`));
  }

  // ----- print: no tick boxes, no player, no controls -----
  if (haveAudio) await p1.evaluate(`document.querySelectorAll('#transcript .seg-play')[0].click()`, true);
  await p1.evaluate(`document.getElementById('tabMom').click()`);
  await p1.media([], 'print');
  const pr = await p1.evaluate(`(() => { const vis = (s) => [...document.querySelectorAll(s)].some((e) => getComputedStyle(e).display !== 'none'); return { tick: vis('.act-tick'), bar: vis('#playBar'), summary: vis('.act-summary'), mom: getComputedStyle(document.getElementById('mom')).display !== 'none', pad: getComputedStyle(document.querySelector('#mom td.act-cell')).paddingLeft }; })()`);
  check('print: tick boxes, the player bar and the count line are not displayed; the minutes are', !pr.tick && !pr.bar && !pr.summary && pr.mom && pr.pad === '10px', JSON.stringify(pr));
  await p1.media([{ name: 'prefers-color-scheme', value: 'light' }], '');

  // ----- widths: nothing scrolls sideways -----
  for (const w of [1280, 640, 360]) {
    await p1.resize(w);
    await sleep(250);
    for (const tab of ['tabMom', 'tabTr']) {
      await p1.evaluate(`document.getElementById('${tab}').click()`);
      const o = await p1.evaluate(`({ sw: document.documentElement.scrollWidth, iw: innerWidth })`);
      check(`no sideways scroll at ${w} px (${tab === 'tabMom' ? 'minutes' : 'transcript'})`, o.sw <= o.iw, JSON.stringify(o));
    }
  }
  await p1.resize(1280);

  // ===== 2. screenshots of the minutes page (light and dark, wide and narrow) =====
  if (SHOTS) {
    await seed(meetings); // the lines as they were, so the dialog shows old and new
    for (const scheme of ['light', 'dark']) {
      for (const w of [1280, 360]) {
        const s = await openPage(`chrome-extension://${id}/mom.html?id=mn1`, { width: w, height: w === 360 ? 780 : 900, scheme });
        await s.shot(`minutes-top-${scheme}-${w}`);
        await s.evaluate(`document.querySelector('#mom .act-summary').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80)`);
        await sleep(200);
        await s.shot(`minutes-actions-${scheme}-${w}`);
        await s.evaluate(`document.getElementById('tabTr').click(); window.scrollTo(0, 0)`);
        if (haveAudio) await s.evaluate(`document.querySelectorAll('#transcript .seg-play')[2].click()`, true);
        await sleep(900);
        await s.shot(`minutes-transcript-player-${scheme}-${w}`);
        if (haveAudio && w === 360) {
          const one = await s.evaluate(`(() => { const tops = [...document.querySelectorAll('#playBar .pb-play, #playBar .pb-time, #playBar .pb-back, #playBar .pb-again, #playBar .pb-close')].map((e) => Math.round(e.getBoundingClientRect().top / 4)); return { tops, w: document.documentElement.scrollWidth }; })()`);
          check(`the player bar controls stay on one row at 360 px (${scheme})`, new Set(one.tops).size <= 2 && one.w <= 360, JSON.stringify(one));
        }
        if (haveAudio) {
          await s.evaluate(`document.querySelector('.pb-again').click()`, true);
          await s.waitFor(`document.querySelectorAll('.rr-dialog .rr-text')[1]?.textContent.includes('Fresh')`, 6000);
          await s.shot(`minutes-reread-${scheme}-${w}`);
          await s.evaluate(`[...document.querySelectorAll('.rr-dialog button')].find((b) => b.textContent === 'Keep what I have').click()`);
        }
        await s.evaluate(`document.getElementById('tabMom').click(); document.getElementById('shareBox').open = true; document.getElementById('shareTo').value = 'ravi@outside.org'; document.getElementById('shareSend').click()`);
        await sleep(400);
        await s.shot(`minutes-share-confirm-${scheme}-${w}`);
        await s.close();
      }
    }
  }
  await p1.close();

  // ===== 3. a meeting with no kept recording, and minutes edited by hand =====
  await opts.evaluate(`chrome.storage.local.set({ settings: ${JSON.stringify({ ...settings, keepAudio: false })} })`);
  await opts.evaluate(`localStorage.removeItem('db.mom.keepHint')`);
  const p2 = await openPage(`chrome-extension://${id}/mom.html?id=mn2`);
  await p2.evaluate(`document.getElementById('tabTr').click()`);
  const v2 = await p2.evaluate(`(() => ({ btn: document.querySelectorAll('.seg-play, .timebtn, .rr-gap').length, bar: !!document.getElementById('playBar'), cbs: document.querySelectorAll('#mom input[type=checkbox]').length, summary: !!document.querySelector('#mom .act-summary'), hint: document.getElementById('keepHint').classList.contains('hidden') ? '' : document.getElementById('keepHint').textContent, w: document.querySelector('#transcript .seg').children[0].getBoundingClientRect().width, tt: document.querySelector('#transcript .seg').children[0].textContent }))()`);
  check('without a kept recording the page has no play buttons and no player', v2.btn === 0 && !v2.bar, JSON.stringify(v2));
  check('minutes edited by hand (rows no longer match the items) get no tick boxes at all', v2.cbs === 0 && !v2.summary, JSON.stringify(v2));
  check('one quiet line says how to get playback; the time column is the same width as with buttons', /Turn on Keep the recording in Settings to play lines back\./.test(v2.hint) && v2.w === speech[0] && true || v2.w > 0, JSON.stringify(v2));
  await p2.shot('minutes-nokeep-light-1280');
  await p2.evaluate(`document.getElementById('keepHintX').click()`);
  const p2b = await openPage(`chrome-extension://${id}/mom.html?id=mn2`);
  await p2b.evaluate(`document.getElementById('tabTr').click()`);
  check('once dismissed (or seen) the tip does not come back', await p2b.evaluate(`document.getElementById('keepHint').classList.contains('hidden')`));
  await p2.close();
  await p2b.close();

  // ===== 4. the Open actions page =====
  await seed(forActions);
  const ap = await openPage(`chrome-extension://${id}/actions.html`, { wait: 1200 });
  const g = async () => ap.evaluate(`({ counts: document.getElementById('counts').textContent, groups: [...document.querySelectorAll('.ac-group')].map((s) => ({ h: s.querySelector('h2').textContent, rows: [...s.querySelectorAll('.ac-row .ac-text')].map((t) => t.textContent) })), active: document.querySelector('#modes .active')?.textContent, chips: [...document.querySelectorAll('.ac-row .chip')].map((c) => c.textContent) })`);
  const a0 = await g();
  check('the page counts open and overdue actions in its heading', a0.counts === '6 open · 1 overdue', JSON.stringify(a0.counts));
  check('by meeting: newest meeting first, rows sorted (overdue first)', a0.active === 'By meeting' && a0.groups.map((x) => x.h.replace(/\d+ [A-Z][a-z]{2} \d{4}\d+ open/g, '').trim()).join('|') === 'Weekly sync|Budget review|Last week' && a0.groups[2].rows[0] === 'Prepare the vendor list', JSON.stringify(a0.groups));
  check('the overdue chip appears once, on the overdue action', a0.chips.length === 1 && a0.chips[0] === 'Overdue', JSON.stringify(a0.chips));
  const seg1 = await ap.evaluate(`({ on: [...document.querySelectorAll('#modes button')].filter((b) => b.getAttribute('aria-checked') === 'true').length, cls: document.querySelectorAll('#modes button.active').length, role: document.getElementById('modes').getAttribute('role'), raised: [...document.querySelectorAll('#modes button')].filter((b) => getComputedStyle(b).boxShadow !== 'none').length })`);
  check('exactly one grouping segment is selected, announced and raised', seg1.on === 1 && seg1.cls === 1 && seg1.role === 'radiogroup' && seg1.raised === 1, JSON.stringify(seg1));
  const fmt = await ap.evaluate(`({ subs: [...document.querySelectorAll('.ac-sub')].map((e) => e.textContent), text: [...document.querySelectorAll('.ac-text')].map((e) => e.textContent).join('|'), dues: [...document.querySelectorAll('.ac-due')].map((e) => e.textContent.replace('Overdue', '')) })`);
  check('dates read "16 Nov 2026" everywhere and emphasis marks are plain text', fmt.subs.every((d) => /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(d)) && fmt.dues.every((d) => /^Due: (\d{1,2} [A-Z][a-z]{2} \d{4}|Not stated)$/.test(d)) && /and stars$|and stars\|/.test(fmt.text) && !/\*stars\*/.test(fmt.text), JSON.stringify(fmt));
  await ap.shot('actions-meeting-light-1280');
  await ap.evaluate(`document.querySelector('#modes [data-mode=owner]').click()`);
  const a1b = await g();
  check('by owner: one group per person, "Not stated" last', a1b.groups.map((x) => x.h.replace(/\d+ open/, '')).join('|') === 'Amal Raj|Priya Nair|Team|Not stated', JSON.stringify(a1b.groups.map((x) => x.h)));
  await ap.shot('actions-owner-light-1280');
  await ap.evaluate(`document.querySelector('#modes [data-mode=due]').click()`);
  const a1c = await g();
  check('by due date: Overdue, then the next 7 days, Later, No date set', a1c.groups.map((x) => x.h.replace(/\d+ open/, '')).join('|') === 'Overdue|In the next 7 days|Later|No date set', JSON.stringify(a1c.groups.map((x) => x.h)));
  await ap.shot('actions-due-light-1280');
  await ap.evaluate(`document.querySelector('#modes [data-mode=meeting]').click()`);
  // remembered
  await ap.evaluate(`document.querySelector('#modes [data-mode=owner]').click()`);
  await ap.evaluate(`location.reload()`);
  await sleep(1300);
  check('the grouping choice is remembered', (await g()).active === 'By owner');
  await ap.evaluate(`document.querySelector('#modes [data-mode=meeting]').click()`);
  // filter
  await ap.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'priya'; q.oninput(); })()`);
  const fl = await g();
  check('the filter matches owner or text, as typed', fl.groups.flatMap((x) => x.rows).join('|') === 'Prepare the vendor list', JSON.stringify(fl.groups));
  await ap.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'zzzz'; q.oninput(); })()`);
  check('a filter with no match says so', await ap.evaluate(`document.querySelector('.ac-empty strong').textContent === 'No actions match'`));
  await ap.evaluate(`(() => { const q = document.getElementById('q'); q.value = ''; q.oninput(); })()`);
  // tick: disappears, undo
  const label = await ap.evaluate(`document.querySelector('.ac-row .ac-tick .sr-only').textContent`);
  await ap.evaluate(`document.querySelector('.ac-row input').click()`);
  await sleep(800);
  const tk = await ap.evaluate(`(async () => { const m = (await chrome.storage.local.get('meeting:mn1'))['meeting:mn1']; const m0 = (await chrome.storage.local.get('meeting:mn0'))['meeting:mn0']; const m3 = (await chrome.storage.local.get('meeting:mn3'))['meeting:mn3']; return { counts: document.getElementById('counts').textContent, status: document.getElementById('statusText').textContent, undo: !document.getElementById('undo').classList.contains('hidden'), all: [m, m0, m3].flatMap((x) => x.items.actions).filter((a) => a.status === 'done').map((a) => a.id) }; })()`);
  check('ticking an action makes it disappear, saves it, and offers Undo in the status line', /^Mark done: /.test(label) && /Marked done: /.test(tk.status) && tk.undo && tk.counts.startsWith('5 open') && tk.all.length === 2, JSON.stringify(tk) + label);
  await ap.shot('actions-undo-light-1280');
  await ap.evaluate(`document.getElementById('undo').click()`);
  await sleep(800);
  const un = await ap.evaluate(`({ counts: document.getElementById('counts').textContent, status: document.getElementById('statusText').textContent, all: 0 })`);
  check('Undo brings it back', un.counts.startsWith('6 open') && /^Reopened: /.test(un.status), JSON.stringify(un));
  // show done: last 30 days
  await ap.evaluate(`document.getElementById('showDone').click()`);
  const sd = await ap.evaluate(`({ done: [...document.querySelectorAll('.ac-row.is-done')].map((r) => r.querySelector('.ac-text').textContent), checked: [...document.querySelectorAll('.ac-row.is-done input')].map((c) => c.checked), strike: [...document.querySelectorAll('.ac-row.is-done .ac-text')].map((t) => getComputedStyle(t).textDecorationLine) })`);
  check('"Show done" lists what was done in the last 30 days, struck through and ticked', sd.done.join('|') === 'Send the budget sheet' && sd.checked[0] === true && sd.strike[0] === 'line-through', JSON.stringify(sd));
  await ap.shot('actions-showdone-light-1280');
  await ap.evaluate(`document.querySelector('.ac-row.is-done input').click()`);
  await sleep(800);
  check('a done action can be unticked from there', (await ap.evaluate(`chrome.storage.local.get('meeting:mn1').then((r) => r['meeting:mn1'].items.actions[1].status)`)) === 'open');
  await ap.evaluate(`chrome.storage.local.get('meeting:mn1').then((r) => { const m = r['meeting:mn1']; m.items.actions[1].status = 'done'; m.items.actions[1].doneAt = ${NOW - DAY}; return chrome.storage.local.set({ 'meeting:mn1': m }); })`);
  await ap.evaluate(`document.getElementById('showDone').click()`);
  for (const w of [1280, 640, 360]) {
    await ap.resize(w);
    await sleep(200);
    const o = await ap.evaluate(`({ sw: document.documentElement.scrollWidth, iw: innerWidth })`);
    check(`actions page: no sideways scroll at ${w} px`, o.sw <= o.iw, JSON.stringify(o));
  }
  await ap.resize(1280);
  // keyboard: every control reachable, focus visible on the checkbox
  const kb = await ap.evaluate(`(() => { const c = document.querySelector('.ac-row input'); c.focus(); return { shadow: getComputedStyle(c).boxShadow, hit: document.querySelector('.ac-tick').getBoundingClientRect().height, tabbable: [...document.querySelectorAll('#modes button, #q, #showDone, .ac-row input')].every((e) => e.tabIndex >= 0) }; })()`);
  check('tick boxes have a 44 px target, are keyboard reachable and show a focus ring', kb.hit >= 44 && kb.tabbable && kb.shadow !== 'none', JSON.stringify(kb));

  if (SHOTS) {
    for (const scheme of ['light', 'dark']) {
      for (const w of [1280, 360]) {
        const s = await openPage(`chrome-extension://${id}/actions.html`, { width: w, height: w === 360 ? 780 : 900, scheme, wait: 1200 });
        await s.shot(`actions-meeting-${scheme}-${w}`);
        await s.evaluate(`document.querySelector('#modes [data-mode=owner]').click()`);
        await s.shot(`actions-owner-${scheme}-${w}`);
        await s.evaluate(`document.querySelector('#modes [data-mode=due]').click()`);
        await s.shot(`actions-due-${scheme}-${w}`);
        await s.evaluate(`document.querySelector('#modes [data-mode=meeting]').click(); document.querySelector('.ac-row input').click()`);
        await sleep(800);
        await s.shot(`actions-undo-${scheme}-${w}`);
        await s.evaluate(`document.getElementById('undo').click()`);
        await sleep(500);
        await s.close();
      }
    }
  }
  await ap.close();

  // ----- empty states -----
  await seed({ mn2: { ...meetings.mn2, items: undefined } }, { ...settings, minutesEngine: 'structured' });
  const e1 = await openPage(`chrome-extension://${id}/actions.html`, { wait: 1200 });
  check('no meeting with structured minutes: "Actions appear here after your next meeting\'s minutes are written."', (await e1.evaluate(`document.querySelector('.ac-empty .hint').textContent`)) === "Actions appear here after your next meeting's minutes are written.");
  await e1.shot('actions-empty-light-1280');
  await seed({ mn2: { ...meetings.mn2, items: undefined } }, { ...settings, minutesEngine: 'classic' });
  await e1.evaluate(`location.reload()`);
  await sleep(1200);
  check('with the classic engine it also says how to get them', /Actions are tracked when minutes are written the structured way \(Settings → Minutes\)\./.test(await e1.evaluate(`document.querySelector('.ac-empty .hint').textContent`)));
  await e1.shot('actions-empty-classic-light-1280');
  const none = { ...meetings.mn1, items: { ...items1, actions: items1.actions.map((a) => ({ ...a, status: 'done' })) } };
  await seed({ mn1: none });
  await e1.evaluate(`location.reload()`);
  await sleep(1200);
  check('nothing open: "No open actions."', (await e1.evaluate(`document.querySelector('.ac-empty strong').textContent`)) === 'No open actions.');
  await e1.close();

  // ===== 5. the popup link =====
  await seed(forActions);
  const pop = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 700, wait: 1800 });
  const pl = await pop.evaluate(`(() => { const a = document.getElementById('openActions'); return { hidden: a.classList.contains('hidden'), text: a.textContent.replace(/\\s+/g, ' ').trim(), label: a.getAttribute('aria-label') }; })()`);
  check('the popup shows "Open actions" with the count of open actions', !pl.hidden && pl.text === 'Open actions 6' && pl.label === 'Open actions, 6 open', JSON.stringify(pl));
  await pop.shot('popup-actions-light-380');
  await pop.resize(380);
  await pop.close();
  await seed({ mn1: none });
  const pop2 = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 700, wait: 1800 });
  check('with nothing open the link is not shown', await pop2.evaluate(`document.getElementById('openActions').classList.contains('hidden')`));
  await pop2.close();
  if (SHOTS) {
    await seed(forActions);
    for (const scheme of ['light', 'dark']) {
      const s = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 640, scheme, wait: 1800 });
      await s.shot(`popup-actions-${scheme}-380`);
      await s.close();
    }
  }

  check('no uncaught errors or console errors on any page', problems.filter((p) => !/Failed to load resource|40[0-9]|net::ERR/.test(p)).length === 0, problems.join(' | '));
} catch (e) {
  console.log('FAIL', e.stack);
  failed = true;
} finally {
  proc.kill();
  server.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}
