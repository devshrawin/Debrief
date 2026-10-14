// Regenerates extension/icons/*.png from extension/icons/icon.svg by rasterising in headless Chrome
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

// 16 px hinted variant from docs/redesign/Brand.dc.html (bars and line snapped to whole-ish pixels).
const hinted16 = `<rect width="16" height="16" rx="4" fill="#3a33a8"/><rect x="2" y="2.5" width="12" height="9" rx="2.5" fill="#fff"/><path d="M4 11h3l-3 3z" fill="#fff"/><rect x="3.5" y="4" width="9" height="1.6" rx=".8" fill="#ff7a1a"/><rect x="5" y="5" width="1.6" height="4" rx=".8" fill="#3a33a8"/><rect x="7.2" y="5" width="1.6" height="5" rx=".8" fill="#3a33a8"/><rect x="9.4" y="5" width="1.6" height="3" rx=".8" fill="#3a33a8"/>`;

const svg = (vb, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}">${defs}${body}</svg>`;
const plain = (size) => (size === 16 ? svg(16, hinted16) : svg(128, inner));
// "Call on" variant: the same mark, slightly smaller, inside a saffron halo and ring.
const glow = (size) =>
  size === 16
    ? svg(16, `<rect x="0.5" y="0.5" width="15" height="15" rx="4.5" fill="none" stroke="#ff9a2e" stroke-width="1"/><g transform="translate(1.5 1.5) scale(.8125)">${hinted16}</g>`)
    : svg(
        128,
        `<rect x="6" y="6" width="116" height="116" rx="36" fill="#ff7a1a" opacity=".55" filter="url(#b)"/><rect x="7" y="7" width="114" height="114" rx="35" fill="none" stroke="#ff9a2e" stroke-width="7"/><g transform="translate(14 14) scale(.78125)">${inner}</g>`,
        '<defs><filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter></defs>'
      );

const jobs = [
  ...[16, 32, 48, 128, 512].map((s) => [`icon${s}.png`, s, plain(s)]),
  ...[16, 32, 48].map((s) => [`icon${s}-glow.png`, s, glow(s)]),
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
