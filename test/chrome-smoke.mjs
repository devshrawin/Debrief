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
  check('options switches provider fields', await opts.evaluate(`!document.querySelector('[data-llm=anthropic]').classList.contains('hidden') && document.querySelector('[data-llm=gemini]').classList.contains('hidden')`));

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
    const root = host.__debriefRoot;
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
    await opts.evaluate(`(async () => { await ${alertRec(tabId)}; await new Promise((r) => setTimeout(r, 1300)); document.querySelector('[data-debrief]').__debriefRoot.querySelector('.wrap').dispatchEvent(new MouseEvent('mouseenter')); await new Promise((r) => setTimeout(r, 400)); })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 640, deviceScaleFactor: 2, mobile: false }, opts.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/pill.png`, Buffer.from((await send('Page.captureScreenshot', {}, opts.sessionId)).data, 'base64'));
  }
  await popup.evaluate(`chrome.storage.session.set({ rec: { recording: false } })`);

  check('options shows the email setup with the relay script', await opts.evaluate(`document.getElementById('emailWebhook') && document.getElementById('scriptText').textContent.includes('Debrief mail relay') && document.getElementById('testMail')`));
  const noSetup = await opts.evaluate(`(async () => { document.getElementById('emailWebhook').value = ''; document.getElementById('testMail').click(); await new Promise((r) => setTimeout(r, 800)); return document.getElementById('mailMsg').textContent; })()`);
  check('test email without setup explains what is missing', /Paste the Apps Script/.test(noSetup), noSetup);
  check('MOM page has an Email me button', await mom.evaluate(`!!document.getElementById('mail')`));

  // Auto-stop: Meet's end screen (reported by the page script) and the silence safety net.
  const stopTest = await opts.evaluate(`(async () => {
    const send = (m) => chrome.runtime.sendMessage({ target: 'bg', ...m });
    const { tabId } = await send({ type: 'whoami' });
    const live = (extra = {}) => chrome.storage.session.set({ rec: { recording: true, meetingId: 'mtest', tabId, startedAt: Date.now() - 60000, mic: false, micOn: false, meetCode: 'abc-defg-hij', ...extra } });
    const out = {};
    await live();
    await send({ type: 'meet-ended' });
    await new Promise((r) => setTimeout(r, 1500));
    out.afterEnd = (await chrome.storage.session.get('rec')).rec.recording;
    await live();
    await chrome.storage.session.set({ quietSince: Date.now() - 11 * 60000, heard: true });
    await send({ type: 'level', tab: 0.001, mic: null, ctx: 'running' });
    await new Promise((r) => setTimeout(r, 1500));
    out.afterQuiet = (await chrome.storage.session.get('rec')).rec.recording;
    await live();
    await chrome.storage.session.set({ quietSince: Date.now() - 11 * 60000, heard: true });
    await send({ type: 'level', tab: 0.2, mic: null, ctx: 'running' });
    await new Promise((r) => setTimeout(r, 800));
    out.afterLoud = (await chrome.storage.session.get('rec')).rec.recording;
    await chrome.storage.session.set({ rec: { recording: false } });
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...cur, autoStop: false } });
    await live();
    out.disabled = await send({ type: 'meet-ended' });
    await new Promise((r) => setTimeout(r, 500));
    out.afterDisabled = (await chrome.storage.session.get('rec')).rec.recording;
    await chrome.storage.local.set({ settings: { ...cur, autoStop: true } });
    await chrome.storage.session.set({ rec: { recording: false } });
    return out;
  })()`);
  check('auto-stop: end screen stops, long silence stops, sound keeps going, setting off ignores', stopTest.afterEnd === false && stopTest.afterQuiet === false && stopTest.afterLoud === true && stopTest.afterDisabled === true, JSON.stringify(stopTest));

  // ---- Pro: usage page, dictionary + name tools on the MOM page, sharing box, detection check ----
  const proOpts = await opts.evaluate(`(async () => {
    const send = (m) => chrome.runtime.sendMessage({ target: 'bg', ...m });
    await send({ type: 'usage', entry: { provider: 'gemini', model: 'gemini-3.8-flash', kind: 'llm', req: 17, tin: 1200, tout: 300 } });
    await send({ type: 'usage', entry: { provider: 'gemini', model: 'gemini-3.8-flash', kind: 'llm', req: 1, fail: true, rl: true, learned: { model: 'gemini-3.8-flash', limit: 20 } } });
    await new Promise((r) => setTimeout(r, 600));
    document.querySelector('#nav button[data-tab=usage]').click();
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('#usageTable tbody tr')].map((r) => r.textContent);
    return { rows, totals: document.getElementById('usageTotals').textContent, active: document.getElementById('page-usage').classList.contains('active'),
      dict: !!document.getElementById('dictionary'), share: !!document.getElementById('shareList') && !!document.getElementById('copyScriptAllow'), local: !!document.getElementById('useOllama') && !!document.getElementById('useWhisper'), sites: !!document.getElementById('otherSites'), mode: !!document.getElementById('minutesMode') };
  })()`);
  check('usage page shows counted requests and the learned limit', proOpts.active && proOpts.rows.some((r) => /gemini . gemini-3.8-flash/.test(r) && /Minutes/.test(r) && /of 20/.test(r)) && /[0-9]+ requests/.test(proOpts.totals), JSON.stringify(proOpts));
  if (process.env.SHOTS) {
    const fs = await import('node:fs');
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1.5, mobile: false }, opts.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/usage.png`, Buffer.from((await send('Page.captureScreenshot', {}, opts.sessionId)).data, 'base64'));
  }
  check('settings has dictionary, sharing, local presets, other sites, minutes mode', proOpts.dict && proOpts.share && proOpts.local && proOpts.sites && proOpts.mode);
  check('usage table has a cost-if-paid column and total', proOpts.rows.length > 0 && /if this were paid: about \$[0-9.]+/.test(proOpts.totals), proOpts.totals);

  // ---- Pro: the setup check ----
  const chk = await opts.evaluate(`(async () => {
    document.querySelector('#nav button[data-tab=start]').click();
    document.getElementById('checkup').click();
    await new Promise((r) => setTimeout(r, 2500));
    return { out: document.getElementById('checkupOut').textContent, msg: document.getElementById('checkupMsg').textContent, copy: !document.getElementById('checkupCopy').hidden };
  })()`);
  check('setup check lists keys, quota, microphone, voices and the last meeting without printing a key', /Gemini key/.test(chk.out) && /Voice recognition/.test(chk.out) && /Speaker model file: present/.test(chk.out) && !/AIza|sk-ant/.test(chk.out) && chk.copy, JSON.stringify(chk).slice(0, 600));

  // ---- Pro: the Voices page (no microphone in headless Chrome, so recording itself is not driven here) ----
  const vui = await opts.evaluate(`(async () => {
    const fp = 'A'.repeat(344);
    const people = [{ id: 'v1', name: 'Amal Raj', lang: 'en', centroid: fp, windows: [fp], secs: 21, created: Date.now() }, { id: 'v2', name: 'Priya Nair', lang: 'ml', langs: ['ml'], centroid: fp, windows: [fp], secs: 19, created: Date.now() }];
    await chrome.storage.local.set({ voices: people, 'meeting:vtest': { id: 'vtest', segments: [], voiceSegs: [{ t0: 0, t1: 2, e: fp }], voiceModel: 'x' }, meetingIds: ['vtest'] });
    document.querySelector('#nav button[data-tab=voices]').click();
    await new Promise((r) => setTimeout(r, 500));
    const out = {
      page: document.getElementById('page-voices').classList.contains('active'),
      rows: [...document.querySelectorAll('#voiceList .voice-row')].map((r) => r.textContent),
      toggle: !!document.getElementById('voiceOn') && !!document.getElementById('voiceLearn') && !!document.getElementById('unnamedCard'), privacy: /never saved or uploaded/.test(document.getElementById('page-voices').textContent) && /256 numbers/.test(document.getElementById('page-voices').textContent),
      promptEn: document.getElementById('enrolPrompt').textContent.length > 100,
    };
    document.querySelector('#enrolLang button[data-lang=ml]').click();
    out.promptMl = /[\u0D00-\u0D7F]/.test(document.getElementById('enrolPrompt').textContent);
    out.emptyHidden = document.getElementById('voiceEmpty').hidden;
    // recording without a name is refused with a message, not a crash
    document.getElementById('enrolRec').click();
    await new Promise((r) => setTimeout(r, 300));
    out.needName = /name first/i.test(document.getElementById('enrolMsg').textContent);
    // deleting a learned voice works, with and without "never learn again"
    const real0 = 'A'.repeat(342) + '==';
    await chrome.storage.local.set({ voices: [...(await chrome.storage.local.get('voices')).voices, { id: 'au1', name: 'Unnamed voice 1', auto: true, ready: false, centroid: real0, windows: [real0], secs: 20, meetings: 1, created: Date.now() }] });
    await new Promise((r) => setTimeout(r, 400));
    const press = async (label) => { await new Promise((r) => setTimeout(r, 150)); const b = [...document.querySelectorAll('dialog.dbmodal button')].find((x) => x.textContent === label); if (!b) throw new Error('no dialog button ' + label); b.click(); await new Promise((r) => setTimeout(r, 400)); };
    const row = [...document.querySelectorAll('#voiceList .voice-row')].find((r) => /Unnamed voice 1/.test(r.textContent));
    out.autoRow = !!row;
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    await press('Delete and never learn it again');
    const st = await chrome.storage.local.get(['voices', 'voiceBlock']);
    out.autoDeleted = !st.voices.some((v) => v.id === 'au1') && (st.voiceBlock || []).length === 1;
    await chrome.storage.local.remove('voiceBlock');
    // importing a shared file adds the person; a broken file is refused with a reason
    const real = 'A'.repeat(342) + '==';
    const good = JSON.stringify({ format: 'debrief-voices', version: 1, model: 'wespeaker-resnet34-lm', people: [{ name: 'Imported One', lang: 'hi', centroid: real, windows: [real] }] });
    const inp = document.getElementById('voiceImportFile');
    const feed = async (text) => { const dt = new DataTransfer(); dt.items.add(new File([text], 'v.json', { type: 'application/json' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 500)); };
    await feed(good);
    out.imported = (await chrome.storage.local.get('voices')).voices.some((p) => p.name === 'Imported One') && /Imported 1 new/.test(document.getElementById('voiceShareMsg').textContent);
    await feed('not json');
    out.refused = /not a Debrief voices file/.test(document.getElementById('voiceShareMsg').textContent);
    document.getElementById('voiceForget').click();
    await press('Forget all voices');
    const after = await chrome.storage.local.get(['voices', 'meeting:vtest']);
    out.forgot = after.voices === undefined && after['meeting:vtest'].voiceSegs === undefined;
    out.listEmpty = document.querySelectorAll('#voiceList .voice-row').length === 0;
    await chrome.storage.local.remove(['meeting:vtest']);
    await chrome.storage.local.set({ meetingIds: [] });
    return out;
  })()`);
  check('voices page: list, enrolment prompts in both languages, privacy text, name required, forget-all wipes voices and meeting fingerprints', vui.page && vui.rows.length === 2 && /Amal Raj/.test(vui.rows[0]) && /Malayalam/.test(vui.rows[1]) && vui.toggle && vui.privacy && vui.promptEn && vui.promptMl && vui.emptyHidden && vui.needName && vui.autoRow && vui.autoDeleted && vui.imported && vui.refused && vui.forgot && vui.listEmpty, JSON.stringify(vui));

  const popupWarn = await popup.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 300)); location.reload(); })()`);
  await sleep(1500);
  check('popup warns when a model is near its daily limit', await popup.evaluate(`!document.getElementById('usageWarn').classList.contains('hidden') && /gemini-3.8-flash: [0-9]+ of 20/.test(document.getElementById('usageWarnText').textContent)`));

  // MOM page: attendee-aware names, fix-everywhere tool, share box
  await mom.evaluate(`(async () => { location.reload(); })()`);
  await sleep(1500);
  const momPro = await mom.evaluate(`(async () => {
    const q = (id) => document.getElementById(id);
    q('attendees').value = ['Rahul Verma', 'Amal Raj'].join(String.fromCharCode(10));
    q('attendees').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 300));
    const shareBox = !!q('shareBox') && !!q('shareSend');
    q('fixWrong').value = 'deployment';
    q('fixRight').value = 'rollout';
    q('fixRemember').checked = true;
    q('fixApply').click();
    await new Promise((r) => setTimeout(r, 600));
    const meeting = (await chrome.storage.local.get('meeting:mtest'))['meeting:mtest'];
    const settings = (await chrome.storage.local.get('settings')).settings;
    return { shareBox, attendees: meeting.attendees, seg: meeting.segments[1].text, dict: settings.dictionary, msg: q('fixMsg').textContent, shown: q('transcript').textContent };
  })()`);
  check('MOM page: attendees saved, fix-a-name replaces everywhere and is remembered', momPro.shareBox && momPro.attendees?.[1] === 'Amal Raj' && /rollout/.test(momPro.seg) && /rollout \| deployment/.test(momPro.dict) && /rollout/.test(momPro.shown), JSON.stringify(momPro));

  // Page-reader check (the popup link) answers from a content script
  const diag = await opts.evaluate(`chrome.runtime.sendMessage({ target: 'bg', type: 'pill-state' }).then((r) => ({ ok: r.ok, captionMode: r.captionMode, hasRec: !!r.rec }))`);
  check('pill-state carries the caption mode', diag.ok && diag.captionMode === 'read', JSON.stringify(diag));

  // ---- first-run tour ----
  const tour = await openPage(`chrome-extension://${id}/welcome.html?restart=1`);
  await sleep(800);
  const t0 = await tour.evaluate(`({ h1: document.querySelector('#stage h1').textContent, nav: document.querySelectorAll('#stepsNav button').length, next: document.getElementById('next').textContent, back: document.getElementById('back').style.visibility })`);
  check('tour opens on the welcome step with every step listed', /minutes without taking notes/i.test(t0.h1) && t0.nav === 12 && /Start the tour/.test(t0.next) && t0.back === 'hidden', JSON.stringify(t0));
  if (process.env.SHOTS) {
    const fs = await import('node:fs');
    await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1.4, mobile: false }, tour.sessionId);
    fs.writeFileSync(`${process.env.SHOTS}/tour-welcome.png`, Buffer.from((await send('Page.captureScreenshot', {}, tour.sessionId)).data, 'base64'));
    await tour.evaluate(`document.querySelectorAll('#stepsNav button')[5].click()`);
    await sleep(500);
    fs.writeFileSync(`${process.env.SHOTS}/tour-record.png`, Buffer.from((await send('Page.captureScreenshot', {}, tour.sessionId)).data, 'base64'));
    await tour.evaluate(`document.querySelectorAll('#stepsNav button')[0].click()`);
    await sleep(300);
  }
  const t1 = await tour.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('next').click();
    await wait(300);
    const out = { key: document.querySelector('#stage h1').textContent };
    document.getElementById('t-key').value = 'AIzaNotARealKey';
    [...document.querySelectorAll('#stage button')].find((b) => /Test my key/.test(b.textContent)).click();
    await wait(4500);
    out.status = document.querySelector('#stage .status').textContent;
    document.getElementById('next').click();
    await wait(300);
    out.mic = document.querySelector('#stage h1').textContent;
    document.getElementById('next').click();
    await wait(300);
    out.you = document.querySelector('#stage h1').textContent;
    document.getElementById('t-name').value = 'Tour Tester';
    document.querySelector('#t-langs input[data-lang=ml]').click();
    document.querySelector('#t-langs input[data-lang=ta]').click();
    document.getElementById('next').click();
    await wait(500);
    out.names = document.querySelector('#stage h1').textContent;
    document.getElementById('t-dict').value = 'Amal | Aman';
    document.querySelectorAll('#stepsNav button')[11].click();
    await wait(600);
    const settings = (await chrome.storage.local.get('settings')).settings;
    out.saved = { name: settings.myName, lang: settings.meetingLanguages, dict: settings.dictionary, key: settings.geminiKey };
    out.done = document.querySelector('#stage h1').textContent;
    out.items = [...document.querySelectorAll('.checklist li')].map((l) => l.textContent.slice(0, 30));
    out.finish = document.getElementById('next').textContent;
    return out;
  })()`);
  check('tour: key test reports a clear failure for a bad key', /did not work|invalid|API key/i.test(t1.status), t1.status);
  check('tour: steps advance and answers are saved as you go', /Your microphone/.test(t1.mic) && /name and languages/i.test(t1.you) && /Teach Debrief your names/.test(t1.names) && t1.saved.name === 'Tour Tester' && JSON.stringify(t1.saved.lang) === JSON.stringify(['ml', 'ta']) && t1.saved.dict === 'Amal | Aman', JSON.stringify(t1));
  check('tour: the last step shows a setup checklist and Finish', /ready/i.test(t1.done) && t1.items.length === 7 && t1.finish === 'Finish', JSON.stringify([t1.done, t1.items, t1.finish]));
  await opts.evaluate(`chrome.storage.local.get('settings').then((r) => chrome.storage.local.set({ settings: { ...r.settings, myName: 'Shrawin', meetingLanguages: [], dictionary: '' } }))`);
  check('popup links to the tour', await popup.evaluate(`!!document.getElementById('openTour') && !!document.getElementById('openTour1')`));

  // The amber "a call is on" dot comes from the page script on any supported site.
  const dot = await opts.evaluate(`(async () => {
    const send = (m) => chrome.runtime.sendMessage({ target: 'bg', ...m });
    const { tabId } = await send({ type: 'whoami' });
    await chrome.storage.session.set({ rec: { recording: false } });
    await send({ type: 'in-call', on: true, site: 'Zoom (web client)' });
    await new Promise((r) => setTimeout(r, 300));
    const on = await chrome.action.getBadgeText({ tabId });
    const title = await chrome.action.getTitle({ tabId });
    await send({ type: 'in-call', on: false });
    await new Promise((r) => setTimeout(r, 300));
    const off = await chrome.action.getBadgeText({ tabId });
    return { on, off, title };
  })()`);
  check('amber reminder dot shows during a call on any supported site and clears after', dot.on === '\u25cf' && dot.off === '' && /Zoom/.test(dot.title), JSON.stringify(dot));

  // ---- ask about the minutes ----
  const askPage = await openPage(`chrome-extension://${id}/ask.html`);
  await sleep(900);
  const ask1 = await askPage.evaluate(`({ box: !!document.querySelector('#askBox .ask-row input'), chips: document.querySelectorAll('#askBox .chipbtn').length, count: document.getElementById('count').textContent, scope: document.getElementById('scope').options.length })`);
  check('ask page lists the scope, suggestions and a question box', ask1.box && ask1.chips >= 3 && /meeting/.test(ask1.count) && ask1.scope === 3, JSON.stringify(ask1));
  const askMom = await mom.evaluate(`({ box: !!document.querySelector('#askBox .ask-row input'), title: document.querySelector('#askBox h3')?.textContent })`);
  check('minutes page has an Ask about this meeting box', askMom.box && /Ask about this meeting/.test(askMom.title), JSON.stringify(askMom));
  const askNoKey = await askPage.evaluate(`(async () => {
    const cur = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.set({ settings: { ...cur, geminiKey: '' } });
    const input = document.querySelector('#askBox .ask-row input');
    input.value = 'what was decided?';
    document.querySelector('#askBox .ask-row button').click();
    await new Promise((r) => setTimeout(r, 600));
    const msg = document.querySelector('#askBox .hint').textContent;
    await chrome.storage.local.set({ settings: cur });
    return msg;
  })()`);
  check('asking without a configured model explains what to set up', /Settings/.test(askNoKey), askNoKey);
  check('popup has an Ask a question link on the Meetings tab', await popup.evaluate(`!!document.getElementById('askAll')`));

  // ---- voice model in a real worker (WebAssembly under the extension's CSP) ----
  const ref = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/fbank-ref.json', import.meta.url), 'utf8'));
  const voice = await opts.evaluate(`(async () => {
    const w = new Worker(chrome.runtime.getURL('dist/worker.js'));
    const ask = (msg, transfer = []) => new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(msg, transfer); });
    const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL('models/wespeaker_resnet34_lm.onnx'))).arrayBuffer());
    const t0 = performance.now();
    const ready = await ask({ type: 'init', model: bytes, wasmPaths: chrome.runtime.getURL('vendor/ort/') }, [bytes.buffer]);
    const load = performance.now() - t0;
    const n = ${ref.samples};
    const pcm = new Float32Array(n);
    let st = 12345n;
    for (let i = 0; i < n; i++) {
      st = (st * 1103515245n + 12345n) & 0x7fffffffn;
      const noise = (Number(st) / 0x7fffffff) * 2 - 1;
      pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 0.2 * Math.sin((2 * Math.PI * 1370 * i) / 16000) + 0.1 * Math.sin((2 * Math.PI * 3100 * i) / 16000) + 0.05 * noise;
    }
    const t1 = performance.now();
    const out = await ask({ id: 1, pcm }, [pcm.buffer]);
    const short = await ask({ id: 2, pcm: new Float32Array(4000) });
    w.terminate();
    return { ready: !!ready.ready, loadMs: Math.round(load), embedMs: Math.round(performance.now() - t1), emb: out.emb ? Array.from(out.emb) : null, err: out.error, shortNull: short.emb === null };
  })()`);
  const cosv = (a, b) => a.reduce((x, v, i) => x + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
  check('speaker model loads in a worker in Chrome and reproduces the reference fingerprint', voice.ready && voice.emb && cosv(voice.emb, ref.emb) > 0.995 && voice.shortNull, JSON.stringify({ ...voice, emb: voice.emb && cosv(voice.emb, ref.emb) }));

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
