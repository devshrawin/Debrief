// Real Chrome: a (fake) Google Meet page: Debrief follows the call's mute button and the pill shows it. A copy of the extension that may script localhost is loaded.
// Usage: node test/chrome-meet.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const work = mkdtempSync(path.join(tmpdir(), 'debrief-panel-'));
const EXT = path.resolve('extension');
const profile = path.join(work, 'profile');


const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const out = proc.stdio[3];
const inp = proc.stdio[4];
let pendingHook = null;
let nextId = 1;
const pending = new Map();
let buf = '';
inp.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method && typeof pendingHook === 'function') pendingHook(msg);
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
async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(1500);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, sessionId, evaluate };
}
let failed = false;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};


// a fake Meet page served through request interception, so the real content script (matched on meet.google.com) runs on it
const MEET = 'https://meet.google.com/abc-defg-hij';
const html = `<!doctype html><html><body style="font-family:sans-serif"><h1>Fake Meet</h1>
<button id="mic" aria-label="Turn off microphone (ctrl + d)" data-is-muted="false">Mic</button>
<button aria-label="Turn off camera (ctrl + e)" data-is-muted="false">Cam</button>
<button aria-label="Leave call">Leave</button></body></html>`;

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const ext = await openPage(`chrome-extension://${id}/options.html`);
  await ext.evaluate(`chrome.storage.local.set({ schema: 2, settings: { geminiKey: 'k', sttProvider: 'gemini', llmProvider: 'gemini', followMeetMute: true, captureMic: true, noticeAck: true, pillOnPage: true } })`);

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://meet.google.com/*' }] }, sessionId);
  pendingHook = (m) => { if (m.method === 'Fetch.requestPaused' && m.sessionId === sessionId) send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(html).toString('base64') }, sessionId); };
  await send('Page.navigate', { url: MEET }, sessionId);
  await sleep(2500);
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  check('the fake Meet page loaded with Debrief on it', (await ev(`location.href`)) === MEET);

  // find the tab id and mark it as being recorded (no real capture is possible here), room off, mic wanted
  const tabId = await ext.evaluate(`chrome.tabs.query({ url: 'https://meet.google.com/*' }).then((t) => t[0]?.id)`);
  check('the tab was found', Number.isInteger(tabId), String(tabId));
  await ext.evaluate(`chrome.storage.session.set({ rec: { recording: true, meetingId: 'mm1', tabId: ${tabId}, startedAt: Date.now(), room: false, mic: true, micOn: true, micWanted: true, meetMuted: null } })`);
  await ext.evaluate(`chrome.storage.local.set({ 'meeting:mm1': { id: 'mm1', title: 'T', startedAt: Date.now(), segments: [], errors: [] }, meetingIds: ['mm1'] })`);
  await sleep(2500);
const pillText = async () => (await ext.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => { const r = document.querySelector('[data-debrief]')?.__debriefRoot; const sr = r?.querySelector('.sr'); const b = sr ? sr.getBoundingClientRect() : { width: 0, height: 0 }; return { mic: (r?.querySelector('.mic')?.textContent || '').trim(), all: r?.textContent || '', srSize: [Math.round(b.width), Math.round(b.height)] }; } }).then((x) => x[0].result)`));
  const pillMic = async () => (await pillText()).mic;
  const read = () => ext.evaluate(`chrome.storage.session.get('rec').then((r) => ({ meetMuted: r.rec.meetMuted, micOn: r.rec.micOn, micWanted: r.rec.micWanted }))`);
  const a = await read();
  check('the status text ("Debrief is recording") is not drawn on the pill', (await pillText()).srSize.every((n) => n <= 1), JSON.stringify((await pillText()).srSize));
  check('unmuted in Meet: Debrief learns it (meetMuted false)', a.meetMuted === false, JSON.stringify(a));
  check('the pill says Mic on', /Mic on/.test(await pillMic()), await pillMic());
  await ev(`document.getElementById('mic').setAttribute('data-is-muted', 'true'); document.getElementById('mic').setAttribute('aria-label', 'Turn on microphone (ctrl + d)')`);
  await sleep(2500);
  const b = await read();
  check('muted in Meet: Debrief sees it within a few seconds and stops using the mic', b.meetMuted === true && b.micOn === false && b.micWanted === true, JSON.stringify(b));
  check('the pill shows Mic off while you are muted in the call, with no "muted in the call" sentence', /Mic off/.test(await pillMic()) && !(await pillText()).all.includes('muted in the call'), await pillMic());
  await ev(`document.getElementById('mic').setAttribute('data-is-muted', 'false'); document.getElementById('mic').setAttribute('aria-label', 'Turn off microphone (ctrl + d)')`);
  await sleep(2500);
  const c = await read();
  check('unmuted again: Debrief sees it', c.meetMuted === false, JSON.stringify(c));
  const dbg = await ext.evaluate(`chrome.storage.local.get('meeting:mm1').then((r) => r['meeting:mm1'].debug || [])`);
  check('the meeting records each mute change', dbg.some((x) => /Meet mic: muted/.test(x)) && dbg.some((x) => /Meet mic: unmuted/.test(x)), JSON.stringify(dbg));

} catch (e) {
  console.log('FAIL', e.stack || e);
  failed = true;
} finally {
  try { await send('Browser.close'); } catch {}
  proc.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}
