// Regenerates the README screenshots (docs/img/*.png) from the real extension in headless Chrome, with made-up data
// (a fictional company, fictional people). Usage: npm run build && node scripts/screenshots.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as A from '../src/orgtemplate.js';
import { renderMinutes } from '../src/structured.js';
import { attendanceMarkdown, setEmailNames } from '../src/attendance.js';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const OUT = path.resolve('docs/img');
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-shots-'));

// ---------------------------------------------------------------- the made-up meeting
const at = (d, h, mi) => new Date(2026, 9, d, h, mi).getTime();
const ORG = { orgName: 'Northwind Systems', orgConfidential: 'Northwind Systems | Confidential', orgAccent: '#3b2fa8', myOrgDomains: 'northwind.example' };
const SETTINGS = {
  ...ORG, geminiKey: 'demo-not-a-real-key', llmProvider: 'gemini', sttProvider: 'gemini', minutesFormat: 'template', myName: 'Alex Rivera',
  emailTo: 'alex.rivera@northwind.example', emailWebhook: 'https://script.google.com/macros/s/DEMO/exec', emailAuto: true, voiceOn: true, voiceSamples: true,
  meetingLanguages: ['en', 'hi'], peopleDirectory: '',
};
const DIR = A.parseDirectory(`Dana Whitfield | Ms. | Operations | Programme Director | Contoso Transit | Chair
Marcus Hale | Mr. | Finance | Finance Lead | Contoso Transit
Alex Rivera | Mr. | | Project Manager | Northwind Systems
Priya Nair | Ms. | | Business Analyst | Northwind Systems
Ravi Menon | Mr. | | Integration Lead | Northwind Systems`);
const invited = [
  { name: 'Dana Whitfield', email: 'dana.whitfield@contoso.example', status: 'yes' },
  { name: 'Marcus Hale', email: 'marcus.hale@contoso.example', status: 'yes' },
  { email: 'alex.rivera@northwind.example', status: 'owner' },
  { email: 'priya.nair@northwind.example', status: 'yes' },
  { email: 'ravi.menon@northwind.example', status: 'yes' },
  { email: 'sam.okafor@contoso.example', status: 'no' },
];
const meeting = { id: 'demo1', title: 'Pilot readiness review', url: 'https://meet.google.com/abc-defg-hij', startedAt: at(13, 10, 0), endedAt: at(13, 10, 52), invited, segments: [], errors: [] };
const presence = { 'Dana Whitfield': [20, 3100, 18], 'Marcus Hale': [60, 3000, 9], 'Priya Nair': [30, 3100, 14], 'Ravi Menon': [30, 3000, 12], You: [0, 3120, 30] };
setEmailNames({ 'priya.nair@northwind.example': 'Priya Nair', 'ravi.menon@northwind.example': 'Ravi Menon', 'alex.rivera@northwind.example': 'Alex Rivera' });
A.setOrg(SETTINGS);
const facts = A.buildFacts({ meeting, settings: SETTINGS, dir: DIR, presence });
const known = A.knownParties({ facts, meeting, dir: DIR });
const prose = A.guardProse(A.parseModelOutput(`## Agenda
- Status of the pilot rollout.
- Validator stock and delivery dates.
- Open risks.

## Discussion
| Topic | Discussion / Decision Points | Responsibility |
|---|---|---|
| Pilot rollout | Priya Nair apprised that 6 of 8 depots are live on the new fare system.<br>The Chairperson directed that the remaining two depots go live before the month end. | Northwind Systems |
| Validator stock | Ravi Menon apprised that 140 of 180 validators can be supplied this month.<br>Marcus Hale asked for a written delivery plan for the balance. | Ravi Menon |
| Risks | Network downtime at Depot 7 was discussed; a second link will be provisioned. | Contoso Transit |

## Action Items
| Action Item | Responsibility |
|---|---|
| Share the written validator delivery plan by 19-Oct-26. | Ravi Menon |
| Take the two remaining depots live by 30-Oct-26. | Northwind Systems |
| Provision the second network link at Depot 7. | Contoso Transit |

## Next Meeting
Date and Time: 20-Oct-26, 10:00 AM
Location: Online (Google Meet)`), known);
const officialMd = A.composeMarkdown({ facts, prose, review: ['_Written with 3 model calls._'] });
const standardMd = `# Fare system weekly sync

## Summary
- 6 of 8 depots are live on the new fare system; the last two go live before month end.
- 140 of 180 validators can be supplied this month; a written plan for the balance is due 19-Oct.
- Depot 7 gets a second network link.

## Action Items
| # | Action | Owner | Due |
|---|---|---|---|
| 1 | Share the written validator delivery plan | Ravi Menon | 19-Oct |
| 2 | Take the two remaining depots live | Priya Nair | 30-Oct |
| 3 | Provision a second link at Depot 7 | Marcus Hale | — |

${attendanceMarkdown({ invited, presence, durationSec: 3120, entries: [], myName: 'Alex Rivera' })}`;

// ---------------------------------------------------------------- a stand-in model (so the Live summary and a running job are real)
// `modelDelay` holds every answer back, which keeps a minutes job in its "writing" state for the picture.
let modelDelay = 0;
const model = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    if (modelDelay) await new Promise((r) => setTimeout(r, modelDelay));
    const text = JSON.stringify({ title: 'Pilot readiness review', overview: 'The pilot is on track: six of eight depots are live.', summary: ['Six of eight depots are live on the new fare system', 'Validator supply for the balance needs a written plan'], topics: [], decisions: [{ text: 'The last two depots go live before the month end', at: '00:41' }], actions: [{ text: 'Share the written validator delivery plan', owner: 'Ravi Menon', due: '2026-10-19', at: '01:20', quote: 'I will send the plan' }], risks: [], questions: [], next: [] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const part of text.match(/.{1,40}/gs)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const MODEL = { llmProvider: 'openai', oaBase: `http://127.0.0.1:${model.address().port}/v1`, oaModel: 'demo-model' };

// ---------------------------------------------------------------- Chrome over a pipe
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const out = proc.stdio[3];
const inp = proc.stdio[4];
let nextId = 1;
const pending = new Map();
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
    }
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(url, { width = 1100, height = 800, scale = 1.5 } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(1800);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // full page or an area; white-on-transparent corners are avoided by the page background
  const shot = async (name, { full = true, maxHeight = 2400, clip, rectJs, keepFixed = false } = {}) => {
    // fonts loaded and the liquid segment thumbs (about 400 ms) and fades finished: nothing is caught half way
    await evaluate(`document.fonts.ready.then(() => true)`);
    await sleep(700);
    // sticky save / navigation bars would float in the middle of a full-page capture
    if (!keepFixed) await evaluate(`document.querySelectorAll('body *').forEach((el) => { const p = getComputedStyle(el).position; const cs = getComputedStyle(el); if ((p === 'fixed' || p === 'sticky') && cs.bottom !== 'auto' && cs.top === 'auto') el.style.display = 'none'; })`);
    let c = clip;
    if (full && !clip && !rectJs) {
      const m0 = await send('Page.getLayoutMetrics', {}, sessionId);
      const h = Math.min(maxHeight, Math.ceil(m0.cssContentSize.height));
      await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: scale, mobile: false }, sessionId);
      await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
      console.log('wrote', name);
      return;
    }
    if (rectJs) {
      const r = await evaluate(rectJs);
      c = { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 16), width: Math.min(width, r.width + 32), height: r.height + 32 };
    }
    if (!c && full) {
      const m = await send('Page.getLayoutMetrics', {}, sessionId);
      c = { x: 0, y: 0, width, height: Math.min(maxHeight, Math.ceil(m.cssContentSize.height)), scale: 1 };
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', ...(c ? { clip: { ...c, scale: 1 }, captureBeyondViewport: true } : {}) }, sessionId);
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log('wrote', name);
  };
  // the popup at its real width (380 px) and its full height (the body scrolls inside 600 px)
  const popupShot = async (name) => {
    // the real popup scrolls inside 600 px; the picture shows all of it, so nothing is cut at the bottom
    await evaluate(`document.body.style.maxHeight = 'none'; document.body.style.overflowY = 'visible'`);
    const h = await evaluate(`Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))`); // the whole document, so the capture window never shows a scrollbar the real popup does not have
    await send('Emulation.setDeviceMetricsOverride', { width: 380, height: h, deviceScaleFactor: scale, mobile: false }, sessionId);
    await evaluate(`document.fonts.ready.then(() => true)`);
    await sleep(800);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log('wrote', name);
  };
  return { targetId, sessionId, evaluate, shot, popupShot, sleep };
}

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1200);
  const opts = await openPage(`chrome-extension://${id}/options.html`);

  // ---- seed: settings, meetings, voices (with short audio clips), usage
  await opts.evaluate(`(async () => {
    const meeting = ${JSON.stringify(meeting)};
    const wav = (hz) => {
      const n = 16000 * 3, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
      const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * hz * 2 * Math.PI / 16000) * 5000 * (0.6 + 0.4 * Math.sin(i / 3000)), true);
      return new Blob([b], { type: 'audio/wav' });
    };
    const c = Array.from({ length: 256 }, (_, i) => Math.sin(i) / 16);
    const voices = [
      { id: 'v1', name: 'Alex Rivera', lang: 'en', centroid: c, windows: [c], secs: 24, created: Date.now() - 20 * 86400000 },
      { id: 'v2', name: 'Priya Nair', lang: 'hi', centroid: c, windows: [c], secs: 31, created: Date.now() - 9 * 86400000, auto: true, learnedFrom: ['demo1'] },
      { id: 'v3', name: 'Ravi Menon', lang: 'en', centroid: c, windows: [c], secs: 18, created: Date.now() - 9 * 86400000, auto: true, learnedFrom: ['demo1'] },
      { id: 'v4', name: 'Unnamed voice 1', lang: 'en', centroid: c, windows: [c], secs: 12, created: Date.now() - 2 * 86400000, auto: true, learnedFrom: ['demo1'] },
    ];
    await chrome.storage.local.set({
      schema: 3,
      settings: ${JSON.stringify(SETTINGS)},
      voices,
      'meeting:demo1': { ...meeting, mom: ${JSON.stringify(officialMd)}, model: 'Gemini · gemini-3.8-flash', emailedAt: Date.now() - 3000000, emailedTo: 'alex.rivera@northwind.example', attendees: ['Dana Whitfield', 'Marcus Hale', 'Alex Rivera', 'Priya Nair', 'Ravi Menon'], presence: ${JSON.stringify(presence)}, segments: [{ t: 12, src: 'others', text: 'Six of the eight depots are live on the new fare system.' }, { t: 58, src: 'me', text: 'We will take the last two live before the month end.' }], decided: true, format: 'amnex', job: { state: 'done', beat: Date.now() } },
      'meeting:demo2': { ...meeting, id: 'demo2', title: 'Fare system weekly sync', startedAt: ${at(6, 15, 0)}, endedAt: ${at(6, 15, 38)}, mom: ${JSON.stringify(standardMd)}, model: 'Gemini · gemini-3.8-flash', format: 'standard', emailedAt: Date.now() - 86400000 * 6, emailedTo: 'alex.rivera@northwind.example', segments: [{ t: 3, src: 'others', text: 'Shall we start with the depots?' }], decided: true, job: { state: 'done', beat: 1 } },
      'meeting:demo3': { ...meeting, id: 'demo3', title: 'Vendor call: validator delivery', startedAt: Date.now() - 900000, endedAt: Date.now() - 30000, mom: '', segments: [{ t: 3, src: 'others', text: 'The balance of 40 validators ships next week.' }, { t: 40, src: 'me', text: 'Please send the plan in writing.' }], job: { state: 'queued', countdownEnd: Date.now() + 9000, beat: Date.now() } },
      meetingIds: ['demo3', 'demo1', 'demo2'],
    });
    const db = await new Promise((res, rej) => { const r = indexedDB.open('debrief-voice', 1); r.onupgradeneeded = () => { r.result.createObjectStore('pieces'); r.result.createObjectStore('samples'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const t = db.transaction('samples', 'readwrite'); [['v1', 220], ['v2', 262], ['v3', 196], ['v4', 330]].forEach(([k, hz]) => t.objectStore('samples').put(wav(hz), k)); t.oncomplete = res; t.onerror = () => rej(t.error); });
    return true;
  })()`);

  // ---- the minutes: official format
  const m1 = await openPage(`chrome-extension://${id}/mom.html?id=demo1`, { width: 1100, height: 900 });
  await sleep(1200);
  await m1.shot('minutes-official', { maxHeight: 2700 });

  // ---- standard layout with the attendance table
  const m2 = await openPage(`chrome-extension://${id}/mom.html?id=demo2`, { width: 1100, height: 900 });
  await sleep(800);
  await m2.shot('minutes-standard', { maxHeight: 1500 });

  // ---- the countdown card (the background job is about to write the minutes)
  // the countdown is re-armed right before its shot so it reads a few seconds, not zero
  await opts.evaluate(`(async () => { const k = 'meeting:demo3'; const m = (await chrome.storage.local.get(k))[k]; m.job = { state: 'queued', countdownEnd: Date.now() + 14000, beat: Date.now() }; await chrome.storage.local.set({ [k]: m }); })()`);
  const m3 = await openPage(`chrome-extension://${id}/mom.html?id=demo3`, { width: 1100, height: 900 });
  await sleep(500);
  // the whole card, its button and the countdown running ("Writing automatically in 12 s"), plus the toolbar under it
  const cardBottom = await m3.evaluate(`Math.ceil(document.querySelector('.tabs').getBoundingClientRect().bottom + scrollY)`);
  await m3.shot('countdown', { full: false, clip: { x: 0, y: 0, width: 1100, height: Math.min(900, cardBottom + 32) } });

  // ---- settings: voices
  const v = await openPage(`chrome-extension://${id}/options.html`, { width: 1100, height: 900 });
  await v.evaluate(`document.querySelector('[data-tab="voices"]').click()`);
  await sleep(900);
  await v.shot('voices', { rectJs: `(() => { const h = [...document.querySelectorAll('#page-voices h2')].find((e) => /enrolled/i.test(e.textContent)); const r = h.closest('section, .card').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()` });

  // ---- settings: organisation template
  await v.evaluate(`document.querySelector('[data-tab="minutes"]')?.click()`);
  await sleep(700);
  await v.shot('organisation-template', { maxHeight: 1500 });

  // ---- settings: usage
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  await opts.evaluate(`chrome.storage.local.set({ usage: { '${day}': { 'gemini|gemini-3.5-transcribe|stt': { req: 14, fail: 1, rl: 1, tin: 0, tout: 0, audioSec: 2310 }, 'gemini|gemini-3.8-flash|llm': { req: 6, fail: 0, rl: 0, tin: 41200, tout: 5200, audioSec: 0 } } }, learnedLimits: { 'gemini-3.5-transcribe': 25, 'gemini-3.8-flash': 20 } })`);
  await v.evaluate(`location.reload()`);
  await sleep(1500);
  await v.evaluate(`document.querySelector('[data-tab="usage"]')?.click()`);
  await sleep(600);
  await v.evaluate(`document.querySelector('[data-tab="usage"]')?.click()`);
  await sleep(700);
  await v.shot('usage', { maxHeight: 1200 });

  // ---- the tour: key, ready
  const t = await openPage(`chrome-extension://${id}/welcome.html?restart=1`, { width: 1100, height: 760 });
  await t.evaluate(`document.getElementById('next').click()`);
  await sleep(500);
  await t.evaluate(`document.getElementById('next').click()`);
  await sleep(700);
  await t.shot('tour-ready', { maxHeight: 1700, keepFixed: true }); // the Back / Next capsule is part of the tour
  await t.evaluate(`document.getElementById('back').click()`);
  await t.evaluate(`document.getElementById('back').click()`);
  await sleep(600);
  await t.shot('tour-key', { maxHeight: 1000, keepFixed: true });

  await opts.evaluate(`chrome.storage.local.remove(['usage', 'learnedLimits'])`);
  // ---- the popup while recording
  await opts.evaluate(`chrome.storage.session.set({ rec: { recording: true, meetingId: 'demo1', tabId: 1, startedAt: Date.now() - 754000, mic: true, micOn: true, micWanted: true, meetCode: 'abc-defg-hij' }, levels: { tab: 0.22, mic: 0.05, ctx: 'running', at: Date.now() } })`);
  const pr = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 640, scale: 2 });
  await sleep(1500);
  await pr.evaluate(`chrome.storage.session.set({ levels: { tab: 0.22, mic: 0.05, ctx: 'running', at: Date.now() } })`);
  await sleep(800);
  await pr.popupShot('popup-recording');
  await opts.evaluate(`chrome.storage.session.remove(['rec', 'levels'])`);

  // ---- the minutes page while a job is writing: a real job, held in its writing state by a slow stand-in model
  await opts.evaluate(`(async () => { const k = 'meeting:demo4'; const base = (await chrome.storage.local.get('meeting:demo1'))['meeting:demo1']; const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(MODEL)}, minutesFormat: 'standard' }, [k]: { ...base, parts: undefined, id: 'demo4', title: 'Weekly planning', mom: '', items: undefined, emailedAt: null, job: undefined, format: 'standard', segments: [{ t: 3, src: 'others', text: 'Six of the eight depots are live on the new fare system.' }, { t: 21, src: 'me', text: 'Good. Which ones are still open?' }, { t: 34, src: 'others', text: 'Depot 7 and Depot 8, both waiting for the network link.' }, { t: 58, src: 'others', text: 'The link can be ordered this week.' }] }, meetingIds: ['demo3', 'demo1', 'demo2', 'demo4'] }); })()`);
  modelDelay = 60000;
  const wr = await openPage(`chrome-extension://${id}/mom.html?id=demo4`, { width: 1100, height: 1180 });
  await wr.evaluate(`(document.getElementById('gen') || document.getElementById('genEmpty')).click()`);
  await sleep(2500);
  await wr.shot('writing', { full: false, clip: { x: 0, y: 0, width: 1100, height: 1180 } }); // the toolbar and its status, the job's skeleton below
  await wr.evaluate(`document.getElementById('abort')?.click()`);
  modelDelay = 0;
  await sleep(500);
  await opts.evaluate(`chrome.storage.local.set({ settings: ${JSON.stringify(SETTINGS)} })`);

  // ---- Open actions, Live, and the minutes with ticked actions and the player bar (made-up meetings, removed again)
  {
    const D = 86400000;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const nowMs = Date.now();
    const act = (aid, text, owner, due, atT, status = 'open') => ({ id: aid, text, owner, due, at: atT, quote: '', status, ...(status === 'done' ? { doneAt: nowMs - D } : {}) });
    const mk = (actions) => ({ overview: '', summary: [], topics: [], decisions: [], risks: [], questions: [], next: [], actions });
    const rec = (mid, title, days, actions, extra = {}) => ({ ...meeting, id: mid, title, startedAt: nowMs - days * D, endedAt: nowMs - days * D + 2400000, segments: [{ t: 3, src: 'others', text: 'Opening remarks.' }], items: mk(actions), mom: '# ' + title, format: 'standard', ...extra });
    const acts = {
      demo5: rec('demo5', 'Depot 7 network review', 5, [act('a1', 'Order the second network link for Depot 7', 'Marcus Hale', iso(nowMs + 3 * D), '04:12'), act('a2', 'Confirm the cut-over window with the depot manager', 'Priya Nair', iso(nowMs - 2 * D), '09:30'), act('a3', 'Write up the downtime for the steering group', 'Alex Rivera', 'Not stated', '12:05')]),
      demo6: rec('demo6', 'Validator delivery call', 12, [act('b1', 'Send the written delivery plan for the balance of 40 validators', 'Ravi Menon', iso(nowMs + 9 * D), '01:20'), act('b2', 'Share the test results with the depots', 'Priya Nair', iso(nowMs + 25 * D), '07:44'), act('b3', 'Update the stock sheet', 'Ravi Menon', iso(nowMs - 6 * D), '11:02', 'done')]),
    };
    const ids = ['demo3', 'demo1', 'demo2'];
    await opts.evaluate(`(async () => { const l = ${JSON.stringify(acts)}; await chrome.storage.local.set({ 'meeting:demo5': l.demo5, 'meeting:demo6': l.demo6, meetingIds: ['demo3', 'demo1', 'demo2', 'demo5', 'demo6'] }); })()`);
    const ac = await openPage(`chrome-extension://${id}/actions.html`, { width: 1100, height: 760 });
    await ac.evaluate(`document.querySelector('#modes [data-mode=due]').click(); document.activeElement?.blur()`);
    await sleep(300);
    await ac.shot('actions', { full: false, clip: { x: 0, y: 0, width: 1100, height: 760 } });
    await opts.evaluate(`chrome.storage.local.remove(['meeting:demo5', 'meeting:demo6']).then(() => chrome.storage.local.set({ meetingIds: ${JSON.stringify(ids)} }))`);

    // Live: a meeting that is being recorded, with a summary so far
    const speech = [
      [4, 'me', 'Let us start with the pilot. Priya, where are we on the depots?'],
      [19, 'others', 'Six of the eight depots are live on the new fare system. The last two are waiting for the network link at Depot 7.'],
      [41, 'others', 'If the second link is ordered this week, both can go live before the month end.'],
      [63, 'me', 'Good. Marcus, can you order the link today?'],
      [71, 'others', 'Yes, I will place the order this afternoon and confirm the date.'],
      [96, 'others', 'On validators, 140 of the 180 can be supplied this month. We still need a written delivery plan for the balance.'],
      [124, 'me', 'Ravi, please send the plan in writing. I will send the plan to Dana after that.'],
      [150, 'others', 'I will send the plan by the nineteenth, together with the test results from the first depots.'],
    ].map(([t, src, text]) => ({ t, src, text }));
    await opts.evaluate(`(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(MODEL)} }, 'meeting:demo8': { ...${JSON.stringify(meeting)}, id: 'demo8', title: 'Pilot readiness review', startedAt: Date.now() - 190000, endedAt: undefined, segments: ${JSON.stringify(speech)}, screens: [{ t: 52, text: 'Slide: depot go-live tracker', presenter: 'Priya Nair' }] }, meetingIds: ['demo8', 'demo3', 'demo1', 'demo2'] }); await chrome.storage.session.set({ rec: { recording: true, meetingId: 'demo8', tabId: 1, startedAt: Date.now() - 190000, mic: true, micOn: true, micWanted: true } }); })()`);
    const lv = await openPage(`chrome-extension://${id}/live.html?id=demo8`, { width: 1100, height: 800 });
    await sleep(1500);
    await lv.evaluate(`document.getElementById('sumGo').click()`);
    for (let i = 0; i < 40 && (await lv.evaluate(`document.getElementById('sumOut').classList.contains('hidden')`)); i++) await sleep(250);
    await lv.evaluate(`window.scrollTo(0, 0)`);
    await lv.shot('live', { full: false, clip: { x: 0, y: 0, width: 1100, height: 800 } });
    await opts.evaluate(`chrome.storage.session.remove('rec'); chrome.storage.local.remove('meeting:demo8').then(() => chrome.storage.local.set({ settings: ${JSON.stringify(SETTINGS)}, meetingIds: ${JSON.stringify(ids)} }))`);

    // the minutes with ticked actions, and the player bar open on a line of the kept recording
    const items7 = mk([act('c1', 'Take the two remaining depots live', 'Priya Nair', iso(nowMs + 10 * D), '00:41', 'done'), act('c2', 'Share the written validator delivery plan', 'Ravi Menon', iso(nowMs + 2 * D), '01:20'), act('c3', 'Provision the second network link at Depot 7', 'Marcus Hale', iso(nowMs + 6 * D), '02:05')]);
    items7.decisions = [{ text: 'The last two depots go live before the month end', at: '00:41' }];
    items7.summary = ['Six of eight depots are live on the new fare system.', 'A second network link for Depot 7 unblocks the last two.'];
    items7.overview = 'The pilot is on track. The remaining work is the network link and the validator plan.';
    const mom7 = renderMinutes(items7, { meeting: { title: 'Fare system weekly sync', startedAt: nowMs - 3600000, endedAt: nowMs - 600000 }, attendees: ['Alex Rivera', 'Priya Nair', 'Ravi Menon', 'Marcus Hale'] });
    const clips = await opts.evaluate(`(async () => {
      if (typeof MediaRecorder === 'undefined') return 'no MediaRecorder';
      const clip = async (freq) => { const ac = new AudioContext(); const osc = ac.createOscillator(); osc.frequency.value = freq; const dest = ac.createMediaStreamDestination(); osc.connect(dest); osc.start();
        const r = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' }); const ch = []; r.ondataavailable = (e) => e.data.size && ch.push(e.data);
        const stopped = new Promise((res) => (r.onstop = res)); r.start(); await new Promise((res) => setTimeout(res, 4000)); r.stop(); await stopped; osc.stop(); ac.close(); return new Blob(ch, { type: 'audio/webm' }); };
      const db = await new Promise((res, rej) => { const r = indexedDB.open('debrief-audio', 1); r.onupgradeneeded = () => { const st = r.result.createObjectStore('seg', { keyPath: ['meetingId', 'seq'] }); st.createIndex('meetingId', 'meetingId'); st.createIndex('savedAt', 'savedAt'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const [seq, t0, f] of [[0, 0, 330], [1, 41, 392]]) { const blob = await clip(f); await new Promise((res, rej) => { const t = db.transaction('seg', 'readwrite'); t.objectStore('seg').put({ meetingId: 'demo7', seq, t0, dur: 4, blob, savedAt: Date.now() }); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
      db.close(); return 'ok'; })()`);
    const lines7 = [[2, 'Welcome, everyone. Let us go through the depots.'], [41, 'Both remaining depots will go live before the month end.'], [80, 'The network link at Depot 7 is the blocker.'], [125, 'Ravi will send the delivery plan in writing.']].map(([t, text], i) => ({ t, src: 'others', text, c: i * 30, dur: 30 }));
    await opts.evaluate(`(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, keepAudio: true }, 'meeting:demo7': { ...${JSON.stringify(meeting)}, id: 'demo7', title: 'Fare system weekly sync', startedAt: ${nowMs - 3600000}, endedAt: ${nowMs - 600000}, segments: ${JSON.stringify(lines7)}, items: ${JSON.stringify(items7)}, mom: ${JSON.stringify(mom7)}, model: 'Gemini · gemini-3.8-flash', format: 'standard' }, meetingIds: ['demo7', 'demo3', 'demo1', 'demo2'] }); })()`);
    const mp = await openPage(`chrome-extension://${id}/mom.html?id=demo7`, { width: 1100, height: 800 });
    await sleep(800);
    if (clips === 'ok') {
      await mp.evaluate(`[...document.querySelectorAll('#mom .timebtn')].find((b) => /00:41/.test(b.textContent))?.click()`);
      await sleep(900);
    }
    await mp.evaluate(`document.querySelector('#mom .act-summary').scrollIntoView({ block: 'start' }); window.scrollBy(0, -30)`); // the table sits in the upper half; the player bar floats below it
    await sleep(300);
    await mp.shot('minutes-actions', { full: false, keepFixed: true }); // the visible window (the page is scrolled, so no clip)
    await opts.evaluate(`chrome.storage.local.remove('meeting:demo7').then(() => chrome.storage.local.set({ settings: ${JSON.stringify(SETTINGS)}, meetingIds: ${JSON.stringify(ids)} }))`);
  }

  // ---- Ask page, the first settings page
  const ask = await openPage(`chrome-extension://${id}/ask.html`, { width: 1100, height: 760 });
  await sleep(900);
  await ask.evaluate(`document.querySelector('#askBox input')?.focus()`);
  await sleep(900);
  await ask.shot('ask', { full: false, clip: { x: 0, y: 0, width: 1100, height: 700 } });
  const st = await openPage(`chrome-extension://${id}/options.html`, { width: 1100, height: 900 });
  await sleep(900);
  await st.shot('settings-start', { maxHeight: 1500 });

  // ---- Appearance, and the popup + minutes in the dark theme
  const ap = await openPage(`chrome-extension://${id}/options.html`, { width: 1100, height: 900 });
  await ap.evaluate(`document.querySelector('#nav [data-tab="appearance"]').click()`);
  await sleep(900);
  await ap.shot('appearance', { full: false, clip: { x: 0, y: 0, width: 1100, height: 760 } });
  await opts.evaluate(`chrome.storage.local.set({ uiTheme: 'dark' })`);
  await sleep(400);
  const dk = await openPage(`chrome-extension://${id}/mom.html?id=demo2`, { width: 1100, height: 800 });
  await sleep(1500);
  await dk.shot('minutes-dark', { full: false, clip: { x: 0, y: 0, width: 1100, height: 800 } });
  const dp = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 640, scale: 2 });
  await sleep(900);
  await dp.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>#modeBox{display:block !important}#cantRecord{display:none !important}</style>'); document.getElementById('start').disabled = false;`);
  await sleep(400);
  await dp.popupShot('popup-dark');
  await opts.evaluate(`chrome.storage.local.remove('uiTheme')`);
  await sleep(300);

  // ---- Chrome Web Store screenshots, exactly 1280 x 800
  const store = async (name, url, prep) => {
    const pg = await openPage(url, { width: 1280, height: 800, scale: 1 });
    await sleep(900);
    if (prep) { await pg.evaluate(prep); await sleep(700); }
    await pg.shot(name, { full: false, clip: { x: 0, y: 0, width: 1280, height: 800 }, keepFixed: true }); // a viewport-sized shot: floating bars stay where they really are
  };
  await store('store-1-minutes', `chrome-extension://${id}/mom.html?id=demo1`);
  await store('store-2-settings', `chrome-extension://${id}/options.html`, `document.querySelector('[data-tab="voices"]').click()`);
  await store('store-3-tour', `chrome-extension://${id}/welcome.html?restart=1`);
  await store('store-4-ask', `chrome-extension://${id}/ask.html`, `document.querySelector('#askBox input')?.focus()`);

  // ---- the popup, as it looks outside a meeting
  const p = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 760, scale: 2 });
  // a popup opened as a page cannot record its own tab: show the idle popup as it looks on a meeting tab
  await p.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>#modeBox{display:block !important}#cantRecord{display:none !important}</style>'); document.getElementById('modeOnline')?.click(); document.getElementById('modeHint').textContent = 'Online meeting: the call is recorded from this tab and your voice from your microphone.'; document.getElementById('start').disabled = false;`);
  await sleep(500);
  await p.popupShot('popup');

  // ---- PDF=<dir>: the official and the standard minutes as the print preview makes them (page footer and header included)
  if (process.env.PDF) {
    for (const [name, url] of [['official', 'mom.html?id=demo1'], ['standard', 'mom.html?id=demo2']]) {
      const pg = await openPage(`chrome-extension://${id}/${url}`, { width: 1100, height: 900 });
      await sleep(1500);
      await send('Emulation.setEmulatedMedia', { media: 'print' }, pg.sessionId);
      const r = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false }, pg.sessionId);
      writeFileSync(path.join(process.env.PDF, `minutes-${name}.pdf`), Buffer.from(r.data, 'base64'));
      console.log('wrote pdf', name);
    }
  }

  // ---- UI audit set (AUDIT=1): every Settings page, the tour, the popup and the minutes, in light and dark, into docs/img/audit
  if (process.env.AUDIT) {
    mkdirSync(path.join(OUT, 'audit'), { recursive: true });
    for (const theme of ['light', 'dark']) {
      await opts.evaluate(theme === 'dark' ? `chrome.storage.local.set({ uiTheme: 'dark' })` : `chrome.storage.local.remove('uiTheme')`);
      await sleep(500);
      for (const tab of ['start', 'general', 'speech', 'minutes', 'email', 'voices', 'usage', 'appearance']) {
        const pg = await openPage(`chrome-extension://${id}/options.html`, { width: 1280, height: 900 });
        await pg.evaluate(`document.querySelector('#nav [data-tab="${tab}"]').click()`);
        await sleep(800);
        if (tab === 'start') { await pg.evaluate(`document.getElementById('checkup').click()`); await sleep(2600); } // show the check-my-setup results too
        await pg.shot(`audit/${theme}-settings-${tab}`, { maxHeight: 6000 });
      }
      for (const step of [0, 1, 2]) {
        const tr = await openPage(`chrome-extension://${id}/welcome.html?restart=1`, { width: 1280, height: 900 });
        await sleep(600);
        for (let i = 0; i < step; i++) { await tr.evaluate(`document.getElementById('next').click()`); await sleep(500); }
        await sleep(400);
        await tr.shot(`audit/${theme}-tour-${step + 1}`, { maxHeight: 2000 });
      }
      const pop = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 760, scale: 2 });
      await pop.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>#modeBox{display:block !important}#cantRecord{display:none !important}</style>'); document.getElementById('start').disabled = false;`);
      await sleep(600);
      await pop.popupShot(`audit/${theme}-popup-home`);
      await pop.evaluate(`document.getElementById('tabMeet').click()`);
      await sleep(600);
      await pop.popupShot(`audit/${theme}-popup-meetings`);
      await opts.evaluate(`chrome.storage.session.set({ rec: { recording: true, meetingId: 'demo1', tabId: 1, startedAt: Date.now() - 754000, mic: true, micOn: true, micWanted: true, meetCode: 'abc-defg-hij' }, levels: { tab: 0.22, mic: 0.05, ctx: 'running', at: Date.now() } })`);
      const pr = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 760, scale: 2 });
      await sleep(1200);
      await pr.popupShot(`audit/${theme}-popup-recording`);
      await opts.evaluate(`chrome.storage.session.set({ rec: { recording: true, stopping: true, meetingId: 'demo1', tabId: 1, startedAt: Date.now() - 754000 } })`);
      const pf = await openPage(`chrome-extension://${id}/popup.html`, { width: 380, height: 760, scale: 2 });
      await sleep(1200);
      await pf.popupShot(`audit/${theme}-popup-finishing`);
      await opts.evaluate(`chrome.storage.session.set({ rec: { recording: false } })`);
      for (const [name, url] of [['minutes-official', 'mom.html?id=demo1'], ['minutes-standard', 'mom.html?id=demo2'], ['ask', 'ask.html']]) {
        const pg = await openPage(`chrome-extension://${id}/${url}`, { width: 1280, height: 900 });
        await sleep(1200);
        await pg.shot(`audit/${theme}-${name}`, { maxHeight: 6000 });
      }
      const tx = await openPage(`chrome-extension://${id}/mom.html?id=demo2`, { width: 1280, height: 900 });
      await sleep(1000);
      await tx.evaluate(`document.getElementById('tabTranscript')?.click() || [...document.querySelectorAll('.tabs button')].find((b) => /transcript/i.test(b.textContent))?.click()`);
      await sleep(700);
      await tx.shot(`audit/${theme}-minutes-transcript`, { maxHeight: 1800 });
    }
    await opts.evaluate(`chrome.storage.local.remove('uiTheme')`);
  }
} catch (e) {
  console.error('FAILED', e.stack);
  process.exitCode = 1;
} finally {
  proc.kill();
  model.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(process.exitCode || 0);
}
