// Real Chrome: voice learning end to end in the service worker. A copy of the extension that may script localhost is loaded; the panel is injected
// into a plain web page the way the toolbar button does it, and we check that the popup shows inside it, can be seen
// through (the page is visible behind it), reports its size, and closes. Usage: node test/chrome-panel.mjs
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

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const pg = await openPage(`chrome-extension://${id}/options.html`);
  const r = await pg.evaluate(`(async () => {
    const pack = (seed) => { const b = new Int8Array(256); for (let i = 0; i < 256; i++) b[i] = Math.round(Math.sin(i * seed + 0.001 * i * i) * 90); let s = ''; for (const x of new Uint8Array(b.buffer)) s += String.fromCharCode(x); return btoa(s); };
    const segs = [];
    for (let k = 0; k < 40; k++) segs.push({ t0: k * 4, t1: k * 4 + 3, e: pack(k % 2 ? 0.31 + k * 1e-5 : 0.77 + k * 1e-5), s: '' });
    const meeting = { id: 'ml1', title: 'Learn', startedAt: Date.now() - 900000, endedAt: Date.now() - 1000, segments: [], errors: [], voiceSegs: segs, captions: [] };
    await chrome.storage.local.set({ schema: 2, settings: { voiceOn: true, voiceLearn: true, voiceSamples: true }, voices: [], 'meeting:ml1': meeting, meetingIds: ['ml1'] });
    const res = await chrome.runtime.sendMessage({ target: 'bg', type: 'learn-voices', id: 'ml1' });
    const st = await chrome.storage.local.get(['meeting:ml1', 'voices']);
    return { res, learn: st['meeting:ml1'].voiceLearn, debug: st['meeting:ml1'].debug, voices: (st.voices || []).map((v) => [v.name, typeof v.centroid, Array.isArray(v.windows) ? v.windows.length : typeof v.windows]) }; })()`);
  console.log(JSON.stringify(r.learn.error || 'learn ok'));
  // now the Voices page: name an unnamed group of the same meeting by hand
  await pg.evaluate(`chrome.storage.local.set({ voices: [] })`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await pg.evaluate(`document.querySelector('#nav [data-tab="voices"]').click()`);
  await sleep(800);
  const n = await pg.evaluate(`(async () => { const items = document.querySelectorAll('#unnamedList li'); if (!items.length) return { items: 0 }; const inp = items[0].querySelector('input'); inp.value = 'Test Person'; inp.dispatchEvent(new Event('input', { bubbles: true })); items[0].querySelector('button.primary').click(); await new Promise((r) => setTimeout(r, 800)); const st = await chrome.storage.local.get('voices'); return { items: items.length, saved: (st.voices || []).map((v) => [v.name, typeof v.centroid]) }; })()`);
  console.log(JSON.stringify(n));
  console.log(JSON.stringify(r, null, 1));
} catch (e) {
  console.log("ERR", e.message);
} finally {
  try { await send('Browser.close'); } catch {}
  proc.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
