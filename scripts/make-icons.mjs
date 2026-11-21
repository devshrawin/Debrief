// Regenerates the state icons (glow, recording) in extension/icons from the brand mark by rasterising in headless Chrome
// (CDP over a pipe, same technique as test/chrome-smoke.mjs). No npm dependencies.
// Usage: node scripts/make-icons.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIR = path.resolve('extension/icons');
const main = readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
const inner = main.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const small = readFileSync(path.join(DIR, 'icon-small.svg'), 'utf8');
const innerSmall = small.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');
const svg = (vb, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}">${body}</svg>`;
// "Call on" variant: the brand mark, a little smaller, inside a flat amber ring (no blur or glow).
const glow = (size) =>
  svg(100, `<rect x="3" y="3" width="94" height="94" rx="26" fill="none" stroke="#F59E0B" stroke-width="${size === 16 ? 8 : 6}"/><g transform="translate(14 14) scale(.72)">${size <= 32 ? innerSmall : inner}</g>`);
// Recording variant: a flat red tile with a white dot.
const rec = () => svg(16, '<rect width="16" height="16" rx="4" fill="#C4271B"/><circle cx="8" cy="8" r="3.2" fill="#fff"/>');
// The plain icons (icon16/32/48/128/512.png) come from the brand pack in docs/brand; only the state variants are drawn here.
const jobs = [
  ...[16, 32, 48].map((s) => [`icon${s}-glow.png`, s, glow(s)]),
  ...[16, 32].map((s) => [`icon${s}-recording.png`, s, rec()]),
];

const profile = mkdtempSync(path.join(tmpdir(), 'debrief-icons-'));
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
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

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  for (const [name, size, markup] of jobs) {
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
    const html = `<!doctype html><html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`;
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') }, sessionId);
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 }, fromSurface: true }, sessionId);
    writeFileSync(path.join(DIR, name), Buffer.from(data, 'base64'));
    console.log('wrote', name);
  }
} finally {
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
