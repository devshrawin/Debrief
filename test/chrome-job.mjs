// Real Chrome: the minutes are written by the background runner with NO minutes tab open, and a job left half-done is
// picked up again when the service worker starts. A throwaway local server stands in for the language model.
// Usage: node test/chrome-job.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-job-'));

let modelCalls = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  modelCalls++;
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = '## Summary\nWe agreed to ship on Friday.\n\n## Action items\n- Send the notes';
    for (const part of text.match(/.{1,12}/gs)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
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
const getMeeting = (page, key) => page.evaluate(`chrome.storage.local.get('meeting:${key}').then((x) => x['meeting:${key}'])`);
async function untilEnded(page, key, tries = 70) {
  let m;
  for (let i = 0; i < tries; i++) {
    m = await getMeeting(page, key);
    if (m?.job?.state === 'done' || m?.job?.state === 'failed') break;
    await sleep(1000);
  }
  return m;
}

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const opts = await openPage(`chrome-extension://${id}/options.html`);
  const seg = JSON.stringify([{ t: 3, src: 'me', text: 'Chaliye shuru karte hain.' }, { t: 65, src: 'others', text: 'We agreed to ship on Friday.' }]);
  const base = `startedAt: Date.now() - 600000, endedAt: Date.now() - 1000, segments: ${seg}, errors: [], mom: ''`;
  await opts.evaluate(`(async () => {
    await chrome.storage.local.set({
      settings: { llmProvider: 'openai', oaBase: 'http://127.0.0.1:${PORT}/v1', oaModel: 'fake', minutesFormat: 'standard', minutesMode: 'quick', calendarLookup: false, emailAuto: false },
      'meeting:jb1': { id: 'jb1', title: 'Background job', ${base} },
      'meeting:jb2': { id: 'jb2', title: 'Left half done', ${base}, decided: true, job: { state: 'writing', beat: 1 } },
      meetingIds: ['jb2', 'jb1'],
    });
  })()`);

  // 1. a job is requested and NO minutes tab is ever opened
  const r = await opts.evaluate(`chrome.runtime.sendMessage({ target: 'bg', type: 'job-run', id: 'jb1' })`);
  check('the background accepts the job', r?.ok && (r.started || r.running), JSON.stringify(r));
  const m = await untilEnded(opts, 'jb1');
  check('minutes written with no minutes tab open', m?.job?.state === 'done' && /ship on Friday/.test(m.mom), JSON.stringify({ state: m?.job?.state, error: m?.job?.error, mom: m?.mom?.slice(0, 40) }));
  const tabs = (await send('Target.getTargets')).targetInfos.filter((t) => t.url.includes('mom.html'));
  check('no minutes page was opened', tabs.length === 0);

  // 2. jb2 was left "writing" with an old beat. A service worker start (resumeJobs) must pick it up: stop the worker, then wake it.
  await sleep(2000);
  const before = modelCalls;
  // stop the service worker, then wake it with a message: its start-up scan (resumeJobs) must pick the job up
  const sw = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
  check('service worker found', !!sw);
  if (sw) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await send('ServiceWorker.enable', {}, sessionId).catch(() => {});
    await send('Runtime.evaluate', { expression: 'self.skipWaiting && 0' }, sessionId).catch(() => {});
    await send('Target.closeTarget', { targetId: sw.targetId }).catch((e) => console.log('closeTarget:', e.message));
  }
  await sleep(2000);
  await opts.evaluate(`chrome.runtime.sendMessage({ target: 'bg', type: 'whoami' }).catch(() => null)`);
  const opts2 = opts;
  const m2 = await untilEnded(opts2, 'jb2');
  check('a stuck job is resumed when the service worker starts', m2?.job?.state === 'done' && /ship on Friday/.test(m2.mom), JSON.stringify({ state: m2?.job?.state, error: m2?.job?.error }));
  check('one model call for the resumed meeting', modelCalls - before === 1, `calls=${modelCalls - before}`);

  // 3. the minutes page is a viewer: opening it twice for a meeting that still needs minutes is ONE job, and it shows the result
  await opts.evaluate(`chrome.storage.local.set({ 'meeting:jb3': { id: 'jb3', title: 'Opened twice', ${base} }, meetingIds: ['jb3', 'jb2', 'jb1'] })`);
  const callsBefore = modelCalls;
  const pageA = await openPage(`chrome-extension://${id}/mom.html?id=jb3`);
  const pageB = await openPage(`chrome-extension://${id}/mom.html?id=jb3`);
  const card = await pageA.evaluate(`({ shown: !document.getElementById('startCard').classList.contains('hidden'), count: document.getElementById('startCount').textContent })`);
  check('the countdown card shows on the page', card.shown && /Writing automatically|Getting ready/.test(card.count), JSON.stringify(card));
  const m3 = await untilEnded(opts, 'jb3');
  await sleep(2500);
  const shown = await pageA.evaluate(`({ mom: document.getElementById('mom').textContent, status: document.getElementById('genStatus').textContent, card: document.getElementById('startCard').classList.contains('hidden') })`);
  check('one job for two page opens', m3?.job?.state === 'done' && modelCalls - callsBefore === 1, `state=${m3?.job?.state} calls=${modelCalls - callsBefore}`);
  check('the page shows the minutes the background wrote', /ship on Friday/i.test(shown.mom) && shown.card && /^Done/.test(shown.status), JSON.stringify(shown).slice(0, 200));
  const bText = await pageB.evaluate(`document.getElementById('mom').textContent`);
  check('the second page shows them too', /ship on Friday/i.test(bText));

  // the minutes can be corrected without typing Markdown: fields, preview, autosave, and an email button that says what it sends
  const ed = await pageA.evaluate(`(async () => {
    const q = (i) => document.getElementById(i);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { label0: q('edit').textContent };
    q('edit').click();
    await wait(300);
    out.fields = document.querySelectorAll('#edBlocks .ed-f').length > 2 && getComputedStyle(q('edBlocks')).display !== 'none' && getComputedStyle(q('mdEdit')).display === 'none';
    const f = [...document.querySelectorAll('#edBlocks .ed-f')].find((x) => x.value.includes('ship on Friday'));
    f.value = f.value.replace('ship on Friday', 'ship on Monday');
    f.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#edTabs [data-v="preview"]').click();
    await wait(150);
    out.preview = q('mdPreview').textContent.includes('ship on Monday');
    await wait(1200);
    const m = (await chrome.storage.local.get('meeting:jb3'))['meeting:jb3'];
    out.autosaved = m.mom.includes('ship on Monday') && !!m.editedAt;
    document.querySelector('#edTabs [data-v="text"]').click();
    out.text = q('mdEdit').value.includes('ship on Monday');
    q('edit').click();
    await wait(400);
    out.done = { label: q('edit').textContent, shown: q('mom').textContent.includes('ship on Monday'), status: q('mailStatus').textContent, chip: [...document.querySelectorAll('#chips .chip')].some((c) => /Edited/.test(c.textContent)) };
    return out;
  })()`);
  check('Edit minutes: ordinary fields, preview, text tab, autosave, "Edited by you", and a clear next step', ed.label0 === 'Edit minutes' && ed.fields && ed.preview && ed.autosaved && ed.text && ed.done.label === 'Edit minutes' && ed.done.shown && /Email me/.test(ed.done.status) && ed.done.chip, JSON.stringify(ed));

  // 4. the background document closes itself when nothing is left to do
  await sleep(4000);
  const left = (await send('Target.getTargets')).targetInfos.filter((t) => t.url.includes('offscreen.html'));
  check('the background document closes when the work is done', left.length === 0, JSON.stringify(left.map((t) => t.url)));
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
