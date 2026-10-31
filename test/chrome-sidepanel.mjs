// Real Chrome: Debrief's side-panel page (popup.html?side=1) in every state, at 320 / 420 / 600 px, light and dark.
// It checks that nothing scrolls sideways, the header, tabs and foot stay in view, the one primary action is right for the state,
// every button has a name, and the page logs no errors. Set SHOTS=<dir> to also write a screenshot of each.
// Usage: node test/chrome-sidepanel.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const work = mkdtempSync(path.join(tmpdir(), 'debrief-side-'));
const EXT = path.join(work, 'ext');
cpSync(path.resolve('extension'), EXT, { recursive: true });
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${path.join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
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
    } else listeners.forEach((fn) => fn(msg));
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};
async function openPage(url, wait = 1200) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(wait);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, sessionId, evaluate };
}

const MEETING = (id, title, extra = {}) => ({ id, title, url: 'https://meet.google.com/abc-defg-hij', startedAt: Date.now() - 42 * 60000, endedAt: Date.now() - 4 * 60000, segments: [], errors: [], ...extra });
const SEGS = [
  { t: 12, src: 'tab', speaker: 'Ravi', text: 'The validator count is 140 this month.' },
  { t: 40, src: 'tab', speaker: 'Priya', text: 'Depot 7 needs the second link before we switch.' },
  { t: 71, src: 'mic', speaker: 'You', text: 'Okay, let us put that on the action list.' },
];
const KEY = { geminiKey: 'AIzaDummyKeyForTest', sttProvider: 'gemini', llmProvider: 'gemini', myName: 'Alex' };

const STATES = {
  idle: { settings: KEY, session: { rec: { recording: false } }, meetings: [MEETING('m1', 'Fare system weekly sync', { emailedAt: Date.now() - 3 * 60000 }), MEETING('m2', 'isn-zfac-vwj')], expect: { foot: /Start recording/i, view: 'idleView' } },
  nokey: { settings: {}, session: { rec: { recording: false } }, meetings: [], expect: { foot: /Start recording/i, view: 'idleView', banner: 'setup' } },
  recording: {
    settings: KEY,
    session: { rec: { recording: true, startedAt: Date.now() - 42 * 60000, meetingId: 'live', mic: true, micOn: true, micWanted: true, tabId: 1 }, levels: { tab: 0.06, mic: 0.004, at: Date.now() + 600000 } },
    meetings: [MEETING('live', 'Weekly planning', { endedAt: null, segments: SEGS })],
    expect: { foot: /Stop and write minutes/i, view: 'recView' },
  },
  meetings: { settings: KEY, session: { rec: { recording: false } }, meetings: [MEETING('m1', 'Fare system weekly sync', { emailedAt: Date.now() - 3 * 60000 }), MEETING('m2', 'isn-zfac-vwj'), MEETING('m3', 'Vendor call: validator delivery')], tab: 'tabMeet', expect: { view: 'idleView', rows: 3 } },
  ask: { settings: KEY, session: { rec: { recording: false } }, meetings: [MEETING('m1', 'Fare system weekly sync')], tab: 'tabAsk', expect: { view: 'idleView', noFoot: true, askBox: true } },
  finishing: { settings: KEY, session: { rec: { recording: true, stopping: true, startedAt: Date.now() - 42 * 60000, meetingId: 'live', tabId: 1 } }, meetings: [MEETING('live', 'Weekly planning', { endedAt: null, segments: SEGS })], expect: { view: 'finView' } },
};

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const ext = await openPage(`chrome-extension://${id}/options.html`);
  for (const [name, st] of Object.entries(STATES)) {
    await ext.evaluate(`(async () => {
      await chrome.storage.local.clear(); await chrome.storage.session.clear();
      await chrome.storage.local.set(${JSON.stringify({ settings: st.settings })});
      for (const m of ${JSON.stringify(st.meetings)}) await chrome.storage.local.set({ ['meeting:' + m.id]: m });
      await chrome.storage.local.set({ meetingIds: ${JSON.stringify(st.meetings.map((m) => m.id))} });
      await chrome.storage.session.set(${JSON.stringify(st.session)});
    })()`);
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 420, 600]) {
        const p = await openPage(`chrome-extension://${id}/popup.html?side=1`, 100);
        const errors = [];
        listeners.push((m) => {
          if (m.sessionId === p.sessionId && m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        });
        await send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false }, p.sessionId);
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, p.sessionId);
        await send('Page.navigate', { url: `chrome-extension://${id}/popup.html?side=1` }, p.sessionId);
        await sleep(1500);
        if (st.tab) { await p.evaluate(`document.getElementById('${st.tab}').click()`); await sleep(700); }
        const m = await p.evaluate(`(() => {
          const vis = (id) => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden') && e.offsetParent !== null; };
          const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
          const foot = [...document.querySelectorAll('#foot button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim().replace(/\\s+/g, ' '));
          const unnamed = [...document.querySelectorAll('button, a.icon-btn, input')].filter((e) => e.offsetParent !== null && !(e.getAttribute('aria-label') || e.textContent.trim() || e.getAttribute('aria-labelledby') || e.title || e.placeholder)).length;
          return { sideX: document.documentElement.scrollWidth > innerWidth, header: r('header.top'), foot: foot.join(' | '), footBox: document.getElementById('foot').offsetParent ? r('#foot') : null, unnamed, rows: document.querySelectorAll('#recent .item').length, ask: !!document.querySelector('#askBox input'), idle: vis('idleView'), rec: vis('recView'), fin: vis('finView'), setup: vis('setup'), ctx: document.getElementById('ctx').textContent, h: innerHeight };
        })()`);
        const label = `${name} ${theme} ${width}px`;
        check(`${label}: nothing scrolls sideways`, !m.sideX);
        check(`${label}: header at the top`, m.header.top === 0);
        const view = st.expect.view;
        check(`${label}: right view (${view})`, st.tab || (view === 'idleView' && m.idle) || (view === 'recView' && m.rec) || (view === 'finView' && m.fin), JSON.stringify({ idle: m.idle, rec: m.rec, fin: m.fin }));
        if (st.expect.foot) check(`${label}: foot action`, st.expect.foot.test(m.foot) && !!m.footBox && m.footBox.bottom <= m.h, `${m.foot} ${JSON.stringify(m.footBox)}`);
        if (view === 'finView') check(`${label}: no foot while finishing`, !m.footBox);
        if (st.expect.banner === 'setup') check(`${label}: no-key banner`, m.setup);
        if (st.expect.rows) check(`${label}: meetings listed`, m.rows === st.expect.rows, String(m.rows));
        if (st.expect.noFoot) check(`${label}: no foot on Ask (the question field is the action)`, !m.footBox);
        if (st.expect.askBox) check(`${label}: the question field is there`, m.ask);
        check(`${label}: every control has a name`, m.unnamed === 0, String(m.unnamed));
        check(`${label}: no script errors`, errors.length === 0, errors[0] || '');
        if (SHOTS) {
          const shot = await send('Page.captureScreenshot', { format: 'png' }, p.sessionId);
          writeFileSync(path.join(SHOTS, `side-${name}-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
        }
        await send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
      }
    }
  }
} catch (e) {
  console.log('FAIL', e.stack || e);
  failed = true;
} finally {
  try { await send('Browser.close'); } catch {}
  proc.kill();
  await sleep(500);
}
console.log(failed ? '\nFAILED' : '\nall ok');
process.exit(failed ? 1 : 0);
