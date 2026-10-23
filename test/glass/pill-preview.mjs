// Renders the on-page pill (CSS taken verbatim from extension/dist/pill.js)
// in its main states over dark and light backgrounds, for visual review.
// The live pill needs a real recording on a meeting page; see docs/TESTING.md.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'extension/dist/pill.js'), 'utf8');
const css = src.slice(src.indexOf('const CSS = `') + 13, src.indexOf('`;', src.indexOf('const CSS = `'))).replace(':host { all: initial; }', '');
const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const pill = (mic, label, extra = '', alert = false) => `<div class="wrap"><div class="pill${alert ? ' alert' : ''}"><span class="rec"></span><span class="eq live"><i></i><i></i><i></i><i></i></span><span class="time">12:48</span>${extra}<button class="mic ${mic}">${MIC}${label}</button></div></div>`;
const panel = `<div class="wrap"><div class="panel"><h4>Debrief <b>is recording</b></h4>
  <div class="meter"><div class="top"><span>Meeting audio</span><span>good</span></div><div class="bar"><div class="fill" style="width:70%"></div></div></div>
  <div class="meter"><div class="top"><span>Your mic</span><span>very quiet</span></div><div class="bar"><div class="fill low" style="width:18%"></div></div></div>
  <div class="alertbox key"><strong><span>⚠ Gemini limit reached</span><button>×</button></strong><p>Audio is kept and sent when the limit resets.</p></div>
  <div class="stats"><div class="stat"><b>38</b><span>transcript segments</span></div><div class="stat err"><b>1</b><span>chunks failed</span></div></div>
  <label class="switch"><span>Ignore my mic while Meet is muted</span><input type="checkbox" checked><span class="track"></span></label>
  <button class="stop">Stop and write the minutes</button></div>${pill('on', 'Mic on')}</div>`;
const html = `<!doctype html><html><head><style>${css}
 body{margin:0;font-family:system-ui;display:grid;grid-template-columns:1fr 1fr;gap:0}
 .bg{padding:28px;display:flex;flex-direction:column;gap:18px;align-items:flex-end;min-height:560px}
 .dark{background:radial-gradient(circle at 30% 30%,#3b4a5a,#0d1014 70%)} .light{background:linear-gradient(135deg,#f4f1ea,#dfe7ef)}
</style></head><body>
<div class="bg dark">${pill('on', 'Mic on')}${pill('off', 'Mic off')}${pill('paused', 'Muted', '<span class="warn-chip show">⚠ Limit</span>', true)}${panel}</div>
<div class="bg light">${pill('on', 'Mic on')}${pill('off', 'Mic off')}${pill('paused', 'Muted', '<span class="warn-chip show">⚠ Limit</span>', true)}${panel}</div>
</body></html>`;
mkdirSync(join(root, 'test/out'), { recursive: true });
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
await p.setContent(html);
await p.waitForTimeout(400);
await p.screenshot({ path: join(root, 'test/out/pill.png'), fullPage: true });
await b.close();
console.log('test/out/pill.png');
