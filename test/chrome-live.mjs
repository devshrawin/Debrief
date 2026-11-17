// Real Chrome: the live page. Seeds a meeting in the old single-record shape, opens live.html, and checks that lines render
// as text, that a line added to storage shows within the poll interval, that a broadcast never doubles a line, that
// scrolling up is respected, and that the summary and Ask work against a throwaway local model. Screenshots go to
// $SHOTS (default: a folder under the OS temp dir).
// Usage: npm run build && CHROME=/path/to/chrome node test/chrome-live.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const SHOTS = process.env.SHOTS || path.join(tmpdir(), 'debrief-live-shots');
mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-live-'));

// A model that answers the structured prompt with JSON and everything else with a sentence. It keeps what it was sent.
const asked = [];
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    asked.push(body);
    const json = /ONE JSON document/.test(body);
    const text = json
      ? JSON.stringify({ title: 'Budget sync', overview: 'They are reviewing the budget so far.', summary: ['The budget was approved for the second quarter'], topics: [], decisions: [{ text: 'Approve the Q2 budget', at: '00:40' }], actions: [], risks: [], questions: [], next: [] })
      : 'The budget was approved for the second quarter [Live budget sync, 12 Oct 2026].';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const part of text.match(/.{1,40}/gs)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(`${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});

async function openPage(url, wait = 1500) {
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
async function shot(page, name, { width, dark }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 800 : 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, page.sessionId);
  await send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' }, page.sessionId);
  await sleep(600);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page.sessionId);
  const file = path.join(SHOTS, `${name}-${width}-${dark ? 'dark' : 'light'}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

let failed = false;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};
const lineCount = (p, text) => p.evaluate(`[...document.querySelectorAll('.lv-line')].filter((l) => l.textContent.includes(${JSON.stringify(text)})).length`);
const until = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
};

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const opts = await openPage(`chrome-extension://${id}/options.html`);
  const now = Date.now();
  const seg = [
    { t: 5, src: 'me', text: 'Let us start with the budget review for the second quarter.' },
    { t: 38, src: 'me', text: 'I will share the numbers after the call.' },
    { t: 62, src: 'others', text: 'The budget is approved for the second quarter, thank you.' },
    { t: 95, src: 'others', text: 'Careful with this one <img src=x onerror=window.__x=1> and <b>bold</b>.' },
    { t: 140, src: 'others', text: 'Ravi will send the vendor contract on Friday, and we meet again on Monday.' },
  ];
  await opts.evaluate(`chrome.storage.local.set({
    settings: { llmProvider: 'openai', oaBase: 'http://127.0.0.1:${PORT}/v1', oaModel: 'fake', myName: 'Amal', sttProvider: 'gemini', sttGeminiChunk: 'standard', minutesFormat: 'standard', minutesEngine: 'structured', calendarLookup: false, emailAuto: false },
    'meeting:lv1': { id: 'lv1', title: 'Live budget sync', startedAt: ${now - 300000}, segments: ${JSON.stringify(seg)}, screens: [{ t: 80, text: 'Slide: Q2 budget table', presenter: 'Priya' }], errors: [] },
    'meeting:lv2': { id: 'lv2', title: 'Another meeting', startedAt: ${now - 900000}, endedAt: ${now - 600000}, segments: [{ t: 3, src: 'others', text: 'OTHERMEETING secret hiring plan words words words.' }], errors: [] },
    meetingIds: ['lv1', 'lv2'],
  })`);

  // lv1 is being recorded: the background's recording state says so (it lives in session storage)
  const setRec = (extra = {}) => opts.evaluate(`chrome.storage.session.set({ rec: ${JSON.stringify({ recording: true, meetingId: 'lv1', tabId: 1, startedAt: now - 300000, mic: true, micOn: true, micWanted: true, ...extra })} })`);
  await setRec();
  const p = await openPage(`chrome-extension://${id}/live.html?id=lv1`, 2500);
  check('lines render, with the time, who and text', (await p.evaluate(`document.querySelectorAll('.lv-line:not(.screen)').length`)) === 5 && (await p.evaluate(`document.querySelector('.lv-line .who').textContent`)) === 'Amal');
  check('the screen note shows as "On screen (Priya): …"', await p.evaluate(`!!document.querySelector('.lv-line.screen') && /^01:20On screen \\(Priya\\): Slide: Q2 budget table$/.test(document.querySelector('.lv-line.screen').textContent)`));
  check('the second line of one speaker folds into the first', await p.evaluate(`document.querySelectorAll('.lv-line')[1].classList.contains('cont')`));
  check('the log is a polite live region', await p.evaluate(`(() => { const l = document.getElementById('log'); return l.getAttribute('role') === 'log' && l.getAttribute('aria-live') === 'polite' && l.getAttribute('aria-relevant') === 'additions'; })()`));
  check('text is inserted as text, never as markup', (await p.evaluate(`window.__x`)) === undefined && (await p.evaluate(`document.getElementById('log').querySelector('img') === null && document.getElementById('log').textContent.includes('<img src=x onerror=window.__x=1>')`)));
  check('the waiting message is gone once there are lines', await p.evaluate(`!document.getElementById('empty')`));
  check('the latency note and the faster-view hint show for Gemini standard', await p.evaluate(`/pieces of about 2 minutes/.test(document.getElementById('latency').textContent) && /choose short pieces in Settings/.test(document.getElementById('latencyHint').textContent) && !document.getElementById('latencyHint').classList.contains('hidden')`));
  check('the header shows the meeting title and a state chip', await p.evaluate(`document.getElementById('mtitle').textContent === 'Live budget sync' && document.getElementById('chipText').textContent.length > 0`), await p.evaluate(`document.getElementById('chipText').textContent`));

  // a line appended to storage shows within the poll interval (no broadcast at all)
  await opts.evaluate(`(async () => { const k = 'meeting:lv1'; const m = (await chrome.storage.local.get(k))[k]; m.segments.push({ t: 170, src: 'others', text: 'STORAGEONLY line that no broadcast announced.' }); await chrome.storage.local.set({ [k]: m }); })()`);
  check('a stored line appears within the poll interval', await until(async () => (await lineCount(p, 'STORAGEONLY')) === 1, 8000));

  // a broadcast from the service worker shows at once, and the re-read that follows does not double it
  const swTarget = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
  check('service worker found (for the fake broadcast)', !!swTarget);
  const swSession = (await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
  const bcast = (msg) => send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify({ target: 'live', type: 'live', meetingId: 'lv1', ...msg })}).catch(() => {})`, awaitPromise: true }, swSession);
  const item = { t: 200, src: 'others', text: 'BROADCASTED line about the launch date.' };
  await bcast({ kind: 'segment', item });
  check('a broadcast line shows at once', await until(async () => (await lineCount(p, 'BROADCASTED')) === 1, 1500));
  await bcast({ kind: 'segment', item });
  await opts.evaluate(`(async () => { const k = 'meeting:lv1'; const m = (await chrome.storage.local.get(k))[k]; m.segments.push(${JSON.stringify(item)}); await chrome.storage.local.set({ [k]: m }); })()`);
  await sleep(7000);
  check('the same line from broadcast, a second broadcast and a re-read shows once', (await lineCount(p, 'BROADCASTED')) === 1, String(await lineCount(p, 'BROADCASTED')));
  const early = { t: 120, src: 'others', text: 'EARLY line that arrived late.' };
  await bcast({ kind: 'segment', item: early });
  await sleep(500);
  check('a line that arrives late is put in time order', await p.evaluate(`(() => { const ts = [...document.querySelectorAll('.lv-line .t')].map((e) => e.textContent); const i = [...document.querySelectorAll('.lv-line')].findIndex((l) => l.textContent.includes('EARLY line')); return i > 0 && ts[i] === '02:00' && ts.slice().sort().join() === ts.join(); })()`));

  // state from a broadcast
  await bcast({ kind: 'state', item: { recording: true, paused: false, startedAt: Date.now() - 125000 } });
  await sleep(500);
  check('a state broadcast gives "Recording · mm:ss"', await p.evaluate(`/^Recording · 0[23]:\\d\\d$/.test(document.getElementById('chipText').textContent)`), await p.evaluate(`document.getElementById('chipText').textContent`));
  await setRec({ paused: true });
  await bcast({ kind: 'state', item: { recording: true, paused: true, startedAt: Date.now() - 125000 } });
  await sleep(400);
  check('paused shows Paused', (await p.evaluate(`document.getElementById('chipText').textContent`)) === 'Paused');
  await setRec();

  // scroll behaviour: fill the log, follow at the bottom, leave the reader alone when they scrolled up
  await opts.evaluate(`(async () => { const k = 'meeting:lv1'; const m = (await chrome.storage.local.get(k))[k]; for (let i = 0; i < 60; i++) m.segments.push({ t: 300 + i * 7, src: i % 3 ? 'others' : 'me', text: 'Filler line number ' + i + ' about the plan.' }); await chrome.storage.local.set({ [k]: m }); })()`);
  await until(async () => (await lineCount(p, 'Filler line number 59')) === 1, 9000);
  await sleep(300);
  // the page is the only scroller: the transcript flows in the window
  const nearBottom = `(() => { const l = document.scrollingElement; return l.scrollHeight - l.scrollTop - l.clientHeight < 60; })()`;
  check('at the bottom the log follows new lines', (await p.evaluate(nearBottom)) && (await p.evaluate(`document.scrollingElement.scrollHeight > innerHeight + 200`)));
  await bcast({ kind: 'segment', item: { t: 900, src: 'others', text: 'FOLLOWED line one at the bottom.' } });
  await sleep(400);
  check('a new line keeps the view at the bottom', await p.evaluate(nearBottom));
  await p.evaluate(`window.scrollTo(0, 0)`);
  await sleep(400);
  await bcast({ kind: 'segment', item: { t: 910, src: 'others', text: 'UNREAD line while scrolled up.' } });
  await sleep(500);
  check('scrolled up: the view is not moved and "New lines" shows', (await p.evaluate(`document.scrollingElement.scrollTop`)) < 5 && (await p.evaluate(`!document.getElementById('newLines').classList.contains('hidden')`)));
  await p.evaluate(`document.getElementById('newLines').click()`);
  await sleep(400);
  check('"New lines" jumps to the bottom and hides', (await p.evaluate(nearBottom)) && (await p.evaluate(`document.getElementById('newLines').classList.contains('hidden')`)));

  check('only the page scrolls: the transcript has no scroller of its own, the header stays at the top, the side column stays in view', await p.evaluate(`(() => { const log = document.getElementById('log'); const head = document.querySelector('.lv-head'); window.scrollTo(0, 400); const t = head.getBoundingClientRect().top; const side = getComputedStyle(document.querySelector('.lv-side')).position; return getComputedStyle(log).overflowY === 'visible' && log.scrollHeight <= log.clientHeight + 1 && t >= 0 && t < 40 && (innerWidth < 900 || side === 'sticky'); })()`));
  await p.evaluate(`window.scrollTo(0, 0)`);

  // summary so far, against the local model
  const before = asked.length;
  await p.evaluate(`document.getElementById('sumGo').click()`);
  check('the summary is provisional and says when it was written', await until(() => p.evaluate(`!document.getElementById('sumOut').classList.contains('hidden') && /^Provisional — written at \\d\\d:\\d\\d from what was said so far\\. The final minutes are written when the meeting ends\\.$/.test(document.getElementById('sumLabel').textContent)`), 10000), await p.evaluate(`document.getElementById('sumStatus').textContent`));
  check('the summary shows the minutes and the button is free again', await p.evaluate(`/approved for the second quarter/i.test(document.getElementById('sumBody').textContent) && !document.getElementById('sumGo').disabled && document.getElementById('sumStop').classList.contains('hidden')`));
  const sumReq = asked.slice(before).find((b) => /ONE JSON document/.test(b)) || '';
  check('only this meeting went to the model', /Live budget sync/.test(sumReq) && !/OTHERMEETING/.test(sumReq) && /still going on/.test(sumReq));
  check('the summary was not stored as the minutes', await opts.evaluate(`chrome.storage.local.get('meeting:lv1').then((r) => !r['meeting:lv1'].mom)`));

  // ask, scoped to this meeting, reading the transcript as it stands
  await opts.evaluate(`(async () => { const k = 'meeting:lv1'; const m = (await chrome.storage.local.get(k))[k]; m.segments.push({ t: 1000, src: 'others', text: 'ASKFRESH the migration moves to November.' }); await chrome.storage.local.set({ [k]: m }); })()`);
  const b2 = asked.length;
  await p.evaluate(`(() => { const i = document.querySelector('#askBox input'); i.value = 'What was decided about the budget?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('Ask answers', await until(() => p.evaluate(`/approved for the second quarter/i.test(document.querySelector('#askBox .ask-a')?.textContent || '')`), 10000));
  const askReq = asked.slice(b2).join('\n');
  check('Ask read the transcript as it stood at the question, and only this meeting', /ASKFRESH/.test(askReq) && !/OTHERMEETING/.test(askReq));

  // layout: no sideways scroll at 360 px, 1280 px, or 200% zoom (a 640 px window)
  for (const width of [1280, 640, 360]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, p.sessionId);
    await sleep(400);
    check(`no horizontal scroll at ${width} px`, await p.evaluate(`document.scrollingElement.scrollWidth <= window.innerWidth`), await p.evaluate(`document.scrollingElement.scrollWidth + ' > ' + window.innerWidth`));
  }
  const files = [];
  await bcast({ kind: 'state', item: { recording: true, paused: false, startedAt: Date.now() - 900000 } });
  for (const dark of [false, true]) for (const width of [1280, 360]) files.push(await shot(p, 'live', { width, dark }));
  await bcast({ kind: 'state', item: { recording: true, paused: false, startedAt: Date.now() - 900000 } });
  await sleep(300);

  check('while recording there is no "Open minutes" and "Summarise so far" is the primary button', await p.evaluate(`document.getElementById('minutesLink').classList.contains('hidden') && document.getElementById('sumGo').classList.contains('primary')`));

  // the meeting ends: Ended, and the link to the minutes
  await opts.evaluate(`(async () => { const k = 'meeting:lv1'; const m = (await chrome.storage.local.get(k))[k]; m.endedAt = Date.now(); await chrome.storage.local.set({ [k]: m }); })()`);
  check('an ended meeting shows Ended and "Open minutes"', await until(() => p.evaluate(`document.getElementById('chipText').textContent === 'Ended' && !document.getElementById('minutesLink').classList.contains('hidden') && /mom\\.html\\?id=lv1$/.test(document.getElementById('minutesLink').getAttribute('href'))`), 8000));
  check('once it has ended "Open minutes" is the primary button and the note about pieces of text is gone', await p.evaluate(`document.getElementById('minutesLink').classList.contains('primary') && !document.getElementById('sumGo').classList.contains('primary') && document.getElementById('latency').classList.contains('hidden')`));

  files.push(await shot(p, 'live-ended', { width: 1280, dark: false }));

  await opts.evaluate(`chrome.storage.session.remove('rec')`);
  // no id and nothing recording
  const e = await openPage(`chrome-extension://${id}/live.html`, 2500);
  check('with nothing recording it says so and links to the meetings', await e.evaluate(`/^Nothing is being recorded right now\\./.test(document.getElementById('log').textContent) && document.querySelector('#log a')?.getAttribute('href') === 'ask.html'`), await e.evaluate(`document.getElementById('log').textContent`));
  files.push(await shot(e, 'live-empty', { width: 1280, dark: false }));
  // a meeting with nothing said yet
  // it is really being recorded: the background says so (the recording state lives in session storage)
  await opts.evaluate(`chrome.storage.session.set({ rec: { recording: true, meetingId: 'lv3', tabId: 1, startedAt: Date.now() - 20000, mic: true, micOn: true, micWanted: true } })`);
  await opts.evaluate(`chrome.storage.local.set({ 'meeting:lv3': { id: 'lv3', title: 'Just started', startedAt: Date.now() - 20000, segments: [], errors: [] }, meetingIds: ['lv3', 'lv1', 'lv2'] })`);
  const w = await openPage(`chrome-extension://${id}/live.html?id=lv3`, 2500);
  check('a meeting with no speech yet says it is waiting', await w.evaluate(`document.getElementById('empty')?.textContent === 'Waiting for the first piece of speech…'`));
  check('a recording with nothing said yet reads "Recording", not "Ended"; no "Open minutes"', await w.evaluate(`/^Recording/.test(document.getElementById('chipText').textContent) && document.getElementById('minutesLink').classList.contains('hidden')`), await w.evaluate(`document.getElementById('chipText').textContent`));
  check('"Summarise so far" waits until there is enough to summarise', await w.evaluate(`document.getElementById('sumGo').disabled`));
  files.push(await shot(w, 'live-waiting', { width: 1280, dark: true }));

  check('no errors on any page', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('screenshots:\n' + files.join('\n'));
} catch (e) {
  console.log('FAIL', e.stack);
  failed = true;
} finally {
  proc.kill();
  server.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}
