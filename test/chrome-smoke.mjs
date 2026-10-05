// Loads the unpacked extension into a throwaway headless Chrome profile over the CDP pipe,
// then opens each page and reports uncaught errors. Usage: node test/chrome-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-'));

const proc = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

const out = proc.stdio[3];
const inp = proc.stdio[4];
let nextId = 1;
const pending = new Map();
const listeners = [];
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
    } else listeners.forEach((l) => l(msg));
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];
listeners.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(`${m.sessionId?.slice(0, 6)} ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});

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
  check('extension loads', !!id, id);
  check('extension id is pinned by manifest key', id === 'nckojmcchehoejdfklcmllhpekagiddo', id);
  await sleep(1000);

  const { targetInfos } = await send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
  check('service worker running', !!sw, sw?.url);

  const opts = await openPage(`chrome-extension://${id}/options.html`);
  check('options renders', await opts.evaluate(`document.getElementById('sttProvider').value === 'gemini' && document.getElementById('llmProvider').value === 'gemini' && !document.getElementById('geminiSection').classList.contains('hidden') && !document.querySelector('[data-stt=gemini]').classList.contains('hidden') && document.querySelector('[data-stt=sarvam]').classList.contains('hidden')`));
  await opts.evaluate(`(() => { const s = document.getElementById('llmProvider'); s.value = 'anthropic'; s.onchange(); const t = document.getElementById('sttProvider'); t.value = 'deepgram'; t.onchange(); })()`);
  check('options switches provider fields', await opts.evaluate(`!document.querySelector('[data-llm=anthropic]').classList.contains('hidden') && document.querySelector('[data-llm=gemini]').classList.contains('hidden') && document.getElementById('geminiSection').classList.contains('hidden')`));

  // Save settings and seed a finished meeting, as the service worker would after a recording.
  await opts.evaluate(`(async () => {
    document.getElementById('myName').value = 'Shrawin';
    document.getElementById('sttProvider').value = 'gemini';
    document.getElementById('llmProvider').value = 'gemini';
    document.getElementById('geminiKey').value = 'AIzaDummyKeyForTest';
    const { settings: before } = await chrome.storage.local.get('settings');
    return true;
  })()`);
  await opts.evaluate(`document.getElementById('save').click()`);
  await sleep(500);
  const saved = await opts.evaluate(`chrome.storage.local.get('settings').then(r => r.settings)`);
  check('settings save', saved?.myName === 'Shrawin' && saved?.geminiKey === 'AIzaDummyKeyForTest' && saved?.llmProvider === 'gemini' && saved?.sttGeminiModel === 'gemini-3.5-transcribe', JSON.stringify({ myName: saved?.myName, llm: saved?.llmProvider }));

  await opts.evaluate(`(async () => {
    const m = { id: 'mtest', title: 'Weekly sync', url: 'https://meet.google.com/abc-defg-hij', startedAt: Date.now() - 42*60000, endedAt: Date.now(),
      segments: [{ t: 3, src: 'me', text: 'Chaliye shuru karte hain.' }, { t: 65, src: 'others', text: 'Rahul, कल तक deployment हो जाएगा?' }],
      errors: [], mom: '# Weekly sync\\n\\n## Action Items\\n| # | Action | Owner | Due |\\n|---|---|---|---|\\n| 1 | Deploy | Rahul | Tomorrow |\\n\\n<img src=x onerror=alert(1)>', stt: 'sarvam' };
    await chrome.storage.local.set({ 'meeting:mtest': m, meetingIds: ['mtest'] });
  })()`);

  // A chunk that failed during the meeting, stored the way the offscreen document stores it.
  await opts.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('debrief', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id', autoIncrement: true }).createIndex('meetingId', 'meetingId');
    req.onsuccess = () => {
      const tx = req.result.transaction('pending', 'readwrite');
      tx.objectStore('pending').add({ meetingId: 'mtest', src: 'others', t: 120, wav: new Blob([new Uint8Array(44 + 32000 * 90)], { type: 'audio/wav' }), error: 'Gemini HTTP 503', savedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  })`);

  const mom = await openPage(`chrome-extension://${id}/mom.html?id=mtest`);
  for (let i = 0; i < 40 && (await mom.evaluate(`document.getElementById('pendingText').textContent.startsWith('Transcribing')`)); i++) await sleep(500);
  check('failed audio is retried on open and stays queued when retry fails', await mom.evaluate(`!document.getElementById('pendingBox').classList.contains('hidden') && document.getElementById('pendingText').textContent.includes('1 audio piece (~1.5 min) still not transcribed. Last error: Gemini HTTP 400')`), await mom.evaluate(`document.getElementById('pendingText').textContent`));
  check('MOM page renders markdown table', await mom.evaluate(`document.querySelectorAll('#mom table td').length === 4`));
  check('raw HTML from model is escaped', await mom.evaluate(`!document.querySelector('#mom img') && document.getElementById('mom').textContent.includes('<img')`));
  check('transcript shows speakers in order', await mom.evaluate(`[...document.querySelectorAll('.seg .who')].map(e => e.textContent).join(',') === 'Shrawin,Others'`));
  check('title field populated', await mom.evaluate(`document.getElementById('title').value === 'Weekly sync'`));

  // Generate with a bogus key: must surface the auth error in the UI rather than hang or crash.
  await mom.evaluate(`document.getElementById('gen').click()`);
  let status = '';
  for (let i = 0; i < 20 && !/Failed|Done/.test(status); i++) {
    await sleep(500);
    status = await mom.evaluate(`document.getElementById('genStatus').textContent`);
  }
  check('generate with bad key reports Gemini auth error', /Failed: Gemini HTTP (400|401|403)/.test(status), status.slice(0, 120));
  check('existing MOM kept after failed generate', await mom.evaluate(`document.querySelectorAll('#mom table td').length === 4`));

  const popup = await openPage(`chrome-extension://${id}/popup.html`);
  const cmds = await popup.evaluate(`chrome.commands.getAll()`);
  check('start/stop shortcut registered', cmds.some((c) => c.name === 'toggle-recording'), JSON.stringify(cmds.map((c) => [c.name, c.shortcut])));
  check('popup shows brand and icon', await popup.evaluate(`document.querySelector('h1.brand img').naturalWidth === 48 && document.querySelector('h1.brand').textContent.includes('Debrief')`));
  if (process.env.SHOTS) {
    const fs = await import('node:fs');
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 520, deviceScaleFactor: 2, mobile: false }, popup.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/popup.png`, Buffer.from((await send('Page.captureScreenshot', {}, popup.sessionId)).data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false }, mom.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/mom.png`, Buffer.from((await send('Page.captureScreenshot', {}, mom.sessionId)).data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false }, opts.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/options.png`, Buffer.from((await send('Page.captureScreenshot', {}, opts.sessionId)).data, 'base64'));
  }
  check('popup renders idle state', await popup.evaluate(`document.getElementById('statusText').textContent === 'Idle' && !document.getElementById('start').classList.contains('hidden')`));
  check('popup lists recent meeting', await popup.evaluate(`document.getElementById('recent').textContent.includes('Weekly sync')`));

  // Offscreen document boots and answers messages (it can't capture a tab headlessly without a user gesture).
  const r = await popup.evaluate(`(async () => {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'test' });
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'mic', on: true });
  })()`);
  check('offscreen document loads and responds', r?.ok === true, JSON.stringify(r));
  const bad = await popup.evaluate(`chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: 'bogus', settings: {}, meetingId: 'x' })`);
  check('offscreen start with invalid stream fails cleanly', bad?.ok === false && !!bad.error, bad?.error);

  // Mic follows Meet's mute button: wiring through the service worker (offscreen has no live capture here).
  const mic = await popup.evaluate(`(async () => {
    await chrome.storage.session.set({ rec: { recording: true, meetingId: 'x', tabId: 1, startedAt: Date.now(), mic: true, micOn: true, micWanted: true, meetMuted: null } });
    const send = (m) => chrome.runtime.sendMessage({ target: 'bg', ...m });
    const out = {};
    out.muted = await send({ type: 'meet-mute', muted: true });
    out.afterMute = (await chrome.storage.session.get('rec')).rec;
    out.who = await send({ type: 'whoami' });
    await chrome.storage.session.set({ rec: { recording: false } });
    return out;
  })()`);
  check('Meet mute pauses my mic but keeps the wish', mic.muted?.ok === true && mic.afterMute.micOn === false && mic.afterMute.micWanted === true && mic.afterMute.meetMuted === true, JSON.stringify(mic.afterMute));
  check('whoami answers', mic.who?.ok === true);

  // On-page pill: run the content script inside an extension page and drive it like Meet would.
  const pillRes = await opts.evaluate(`(async () => {
    const send = (m) => chrome.runtime.sendMessage({ target: 'bg', ...m });
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...cur, pillOnPage: true } });
    const { tabId } = await send({ type: 'whoami' });
    await chrome.storage.session.set({ rec: { recording: true, meetingId: 'x', tabId, startedAt: Date.now() - 65000, mic: true, micOn: true, micWanted: true, meetMuted: false } });
    await chrome.storage.session.set({ levels: { tab: 0.12, mic: 0.05, ctx: 'running', at: Date.now() } });
    await new Promise((res) => { const sc = document.createElement('script'); sc.src = chrome.runtime.getURL('dist/pill.js'); sc.onload = res; document.head.append(sc); });
    await new Promise((r) => setTimeout(r, 1600));
    const host = document.querySelector('[data-debrief]');
    const root = host.shadowRoot;
    const out = { shown: host.style.display !== 'none', time: root.querySelector('.time').textContent, mic: root.querySelector('.mic').textContent.trim() };
    root.querySelector('.mic').click();
    await new Promise((r) => setTimeout(r, 800));
    out.after = root.querySelector('.mic').textContent.trim();
    out.state = (await chrome.storage.session.get('rec')).rec.micWanted;
    await chrome.storage.session.set({ rec: { recording: false } });
    return out;
  })()`);
  check('pill shows timer and mic state, click toggles mic', pillRes.shown && /^01:0/.test(pillRes.time) && pillRes.mic === 'Mic on' && pillRes.after === 'Mic off' && pillRes.state === false, JSON.stringify(pillRes));

  // Screenshots of the recording UI (popup + on-page pill) with a quota alert showing.
  const alertRec = (tabId) => `chrome.storage.session.set({ rec: { recording: true, meetingId: 'mtest', tabId: ${tabId}, startedAt: Date.now() - 754000, mic: true, micOn: true, micWanted: true, meetMuted: false, alert: { kind: 'quota', title: 'API limit reached', detail: 'gemini-3.8-flash: free-tier limit used up, resets in about 18h. Debrief tries other models first; chunks that still fail are kept and retried from the MOM page.', at: Date.now(), notifiedAt: Date.now() } }, levels: { tab: 0.14, mic: 0.02, ctx: 'running', at: Date.now() } })`;
  const popupAlert = await popup.evaluate(`(async () => { await ${alertRec(1)}; await new Promise((r) => setTimeout(r, 1500)); return { alert: !document.getElementById('alert').classList.contains('hidden'), title: document.getElementById('alertTitle').textContent, live: !document.getElementById('live').classList.contains('hidden'), segs: document.getElementById('segInfo').textContent }; })()`);
  check('popup shows the API-limit alert and live meters', popupAlert.alert && /limit/i.test(popupAlert.title) && popupAlert.live, JSON.stringify(popupAlert));
  if (process.env.SHOTS) {
    const fs = await import('node:fs');
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, popup.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/popup-recording.png`, Buffer.from((await send('Page.captureScreenshot', {}, popup.sessionId)).data, 'base64'));
    const tabId = await opts.evaluate(`chrome.runtime.sendMessage({ target: 'bg', type: 'whoami' }).then((r) => r.tabId)`);
    await opts.evaluate(`(async () => { await ${alertRec(tabId)}; await new Promise((r) => setTimeout(r, 1300)); document.querySelector('[data-debrief]').shadowRoot.querySelector('.wrap').dispatchEvent(new MouseEvent('mouseenter')); await new Promise((r) => setTimeout(r, 400)); })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 640, deviceScaleFactor: 2, mobile: false }, opts.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/pill.png`, Buffer.from((await send('Page.captureScreenshot', {}, opts.sessionId)).data, 'base64'));
  }
  // Controller window (outside the Meet page): shows state, mic button flips the mic wish, alert visible.
  const mini = await openPage(`chrome-extension://${id}/mini.html`);
  await mini.evaluate(`(async () => { await ${alertRec(1)}; await new Promise((r) => setTimeout(r, 1500)); })()`);
  const miniState = await mini.evaluate(`({ live: !document.getElementById('live').classList.contains('hidden'), mic: document.getElementById('mic').textContent.trim(), alert: !document.getElementById('alert').classList.contains('hidden'), time: document.getElementById('time').textContent })`);
  check('mini window shows live state, mic and alert', miniState.live && miniState.mic === 'Mic on' && miniState.alert && /^12:/.test(miniState.time), JSON.stringify(miniState));
  if (process.env.SHOTS) {
    const fs = await import('node:fs');
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 330, deviceScaleFactor: 2, mobile: false }, mini.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/mini.png`, Buffer.from((await send('Page.captureScreenshot', {}, mini.sessionId)).data, 'base64'));
  }
  await mini.evaluate(`document.getElementById('mic').click()`);
  await sleep(1200);
  const miniAfter = await mini.evaluate(`({ mic: document.getElementById('mic').textContent.trim(), want: null })`);
  const wantAfter = await mini.evaluate(`chrome.storage.session.get('rec').then((r) => r.rec.micWanted)`);
  check('mini mic button turns the mic off', miniAfter.mic === 'Mic off' && wantAfter === false, JSON.stringify({ miniAfter, wantAfter }));
  await popup.evaluate(`chrome.storage.session.set({ rec: { recording: false } })`);

  check('no uncaught page errors', errors.filter((e) => !/40[013]|API key/i.test(e)).length === 0, errors.join(' | '));
} catch (e) {
  console.log('FAIL harness error:', e.message);
  failed = true;
} finally {
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}
