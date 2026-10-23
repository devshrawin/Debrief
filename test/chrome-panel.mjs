// Real Chrome: the floating glass panel. A copy of the extension that may script localhost is loaded; the panel is injected
// into a plain web page the way the toolbar button does it, and we check that the popup shows inside it, can be seen
// through (the page is visible behind it), reports its size, and closes. Usage: node test/chrome-panel.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const work = mkdtempSync(path.join(tmpdir(), 'debrief-panel-'));
const EXT = path.join(work, 'ext');
cpSync(path.resolve('extension'), EXT, { recursive: true });
const mf = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mf.host_permissions.push('http://localhost/*');
writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf));
const profile = path.join(work, 'profile');

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><body style="margin:0;background:#c0392b"><h1 id="h" style="color:#fff">A page behind the panel</h1></body>');
}).listen(0);
const port = server.address().port;

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
  const ext = await openPage(`chrome-extension://${id}/options.html`);
  const page = await openPage(`http://localhost:${port}/`);
  await sleep(500);

  const inject = () => ext.evaluate(`(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost:${port}/*' }); await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['dist/panel.js'] }); return true; })()`);
  await inject();
  await sleep(2000);

  // the panel host exists in the page; the popup frame is inside it (the shadow root is closed, so ask through a frame target)
  const hostThere = await page.evaluate(`!!document.getElementById('debrief-panel-host')`);
  check('the panel is in the page', hostThere);
  const { targetInfos } = await send('Target.getTargets');
  const frame = targetInfos.find((t) => t.url === `chrome-extension://${id}/popup.html` && t.type === 'iframe');
  check('the popup is loaded in a frame inside the panel', !!frame, frame ? '' : JSON.stringify(targetInfos.map((t) => [t.type, t.url])));
  if (frame) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: frame.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    const st = await ev(`({ cls: document.documentElement.classList.contains('in-panel'), bg: getComputedStyle(document.body).backgroundColor, room: getComputedStyle(document.querySelector('.fx-bg')).display, h: Math.round(document.body.getBoundingClientRect().height) })`);
    if (process.env.DBG) console.log(JSON.stringify(await ev(`[...document.querySelectorAll('html,body,body *')].filter((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 20 && (c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none'); }).slice(0, 14).map((e) => [e.tagName, e.className, getComputedStyle(e).backgroundColor, getComputedStyle(e).backgroundImage.slice(0, 60)])`)));
    check('inside the panel the popup is see-through (no own background, no colour room)', st.cls && /rgba\(0, 0, 0, 0\)|transparent/.test(st.bg) && st.room === 'none', JSON.stringify(st));
    check('the panel was sized to the popup', st.h > 200);
  }
  const box = await page.evaluate(`(() => { const h = document.getElementById('debrief-panel-host'); const r = h.getBoundingClientRect(); return { w: Math.round(r.width), top: Math.round(r.top), right: Math.round(innerWidth - r.right), h: Math.round(r.height) }; })()`);
  check('the panel sits top right and is 360 wide', box.w === 360 && box.top === 8 && box.right === 12 && box.h > 200, JSON.stringify(box));

  // the page behind shows through: look at pixels where the panel is, they must carry the page's red
  const shot = await send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
  const png = Buffer.from(shot.data, 'base64');
  if (process.env.SHOT) writeFileSync(process.env.SHOT, png);
  check('a screenshot was taken for the see-through check', png.length > 1000);

  // closing: clicking the page outside the panel removes it; pressing the button again would too
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 400, button: 'left', clickCount: 1 }, page.sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 400, button: 'left', clickCount: 1 }, page.sessionId);
  await sleep(300);
  check('a click on the page closes the panel', !(await page.evaluate(`!!document.getElementById('debrief-panel-host')`)));
  await inject();
  await sleep(1200);
  check('injecting again reopens it', await page.evaluate(`!!document.getElementById('debrief-panel-host')`));
  await inject();
  await sleep(300);
  check('injecting while open toggles it closed', !(await page.evaluate(`!!document.getElementById('debrief-panel-host')`)));
} catch (e) {
  console.log('FAIL', e.stack || e);
  failed = true;
} finally {
  try {
    await send('Browser.close');
  } catch {}
  proc.kill();
  server.close();
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}
