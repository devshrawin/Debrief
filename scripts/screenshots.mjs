// Regenerates the README screenshots (docs/img/*.png) from the real extension in headless Chrome, with made-up data
// (a fictional company, fictional people). Usage: npm run build && node scripts/screenshots.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as A from '../src/amnex.js';
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
  ...ORG, geminiKey: 'demo-not-a-real-key', llmProvider: 'gemini', sttProvider: 'gemini', minutesFormat: 'amnex', myName: 'Alex Rivera',
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
const standardMd = `# Pilot readiness review

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
  const shot = async (name, { full = true, maxHeight = 2400, clip, rectJs } = {}) => {
    // sticky save / navigation bars would float in the middle of a full-page capture
    await evaluate(`document.querySelectorAll('body *').forEach((el) => { const p = getComputedStyle(el).position; const cs = getComputedStyle(el); if ((p === 'fixed' || p === 'sticky') && cs.bottom !== 'auto' && cs.top === 'auto') el.style.display = 'none'; })`);
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
  return { targetId, evaluate, shot };
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
      schema: 2,
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
  const m3 = await openPage(`chrome-extension://${id}/mom.html?id=demo3`, { width: 1100, height: 700 });
  await sleep(500);
  await m3.shot('countdown', { full: false, clip: { x: 0, y: 0, width: 1100, height: 520 } });

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
  await t.shot('tour-ready', { maxHeight: 1700 });
  await t.evaluate(`document.getElementById('back').click()`);
  await t.evaluate(`document.getElementById('back').click()`);
  await sleep(600);
  await t.shot('tour-key', { maxHeight: 1000 });

  await opts.evaluate(`chrome.storage.local.remove(['usage', 'learnedLimits'])`);
  // ---- the popup while recording
  await opts.evaluate(`chrome.storage.session.set({ rec: { recording: true, meetingId: 'demo1', tabId: 1, startedAt: Date.now() - 754000, mic: true, micOn: true, micWanted: true, meetCode: 'abc-defg-hij' }, levels: { tab: 0.22, mic: 0.05, ctx: 'running', at: Date.now() } })`);
  const pr = await openPage(`chrome-extension://${id}/popup.html`, { width: 400, height: 640, scale: 2 });
  await sleep(1500);
  await pr.evaluate(`chrome.storage.session.set({ levels: { tab: 0.22, mic: 0.05, ctx: 'running', at: Date.now() } })`);
  await sleep(800);
  await pr.shot('popup-recording', { full: false, clip: { x: 0, y: 0, width: 400, height: 560 } });
  await opts.evaluate(`chrome.storage.session.remove(['rec', 'levels'])`);

  // ---- the minutes page while a job is writing (orb, glowing toolbar)
  await opts.evaluate(`(async () => { const k = 'meeting:demo4'; const base = (await chrome.storage.local.get('meeting:demo1'))['meeting:demo1']; await chrome.storage.local.set({ [k]: { ...base, id: 'demo4', title: 'Writing right now', mom: '', emailedAt: null, job: { state: 'writing', status: 'Reading the transcript carefully (part 2 of 3)…', beat: Date.now() + 600000 } }, meetingIds: ['demo4', 'demo3', 'demo1', 'demo2'] }); })()`);
  const wr = await openPage(`chrome-extension://${id}/mom.html?id=demo4`, { width: 1100, height: 760 });
  await sleep(2200);
  await wr.shot('writing', { full: false, clip: { x: 0, y: 0, width: 1100, height: 640 } });

  // ---- Ask page, the first settings page
  const ask = await openPage(`chrome-extension://${id}/ask.html`, { width: 1100, height: 760 });
  await sleep(900);
  await ask.evaluate(`document.querySelector('#askBox input')?.focus()`);
  await sleep(900);
  await ask.shot('ask', { full: false, clip: { x: 0, y: 0, width: 1100, height: 700 } });
  const st = await openPage(`chrome-extension://${id}/options.html`, { width: 1100, height: 900 });
  await sleep(900);
  await st.shot('settings-start', { maxHeight: 1500 });

  // ---- the popup, as it looks outside a meeting
  const p = await openPage(`chrome-extension://${id}/popup.html`, { width: 400, height: 760, scale: 2 });
  // a popup opened as a page cannot record its own tab: show the idle popup as it looks on a meeting tab
  await p.evaluate(`document.getElementById('cantRecord')?.classList.add('hidden'); document.getElementById('modeOnline')?.click(); document.getElementById('start').disabled = false;`);
  await sleep(500);
  await p.shot('popup', { full: false, clip: { x: 0, y: 0, width: 400, height: 360 } });
} catch (e) {
  console.error('FAILED', e.stack);
  process.exitCode = 1;
} finally {
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(process.exitCode || 0);
}
