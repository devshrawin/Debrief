// Real Chrome: a stretch with no transcript is shown on the minutes page (a note in the transcript and a line in the warning box), the
// notes a speech model wrote about the audio never reach the page, and the minutes carry a coverage warning that names the stretch.
// A throwaway local server stands in for the language model. Usage: node test/chrome-gaps.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-gaps-'));

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = '## Summary\nWe agreed the timeline.\n\n## Action items\n- Send the notes';
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
  await sleep(1800);
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
  const opts = await openPage(`chrome-extension://${id}/options.html`);

  // gp1: text for 0-150 s and 400-550 s, nothing from 150 to 400 s (a gap), a pause at 600-700 s on purpose, and notes the model wrote
  const segs = [
    { t: 3, c: 0, dur: 150, src: 'others', text: 'Silent audio track (only background noise).\n- Output: Nothing\nWe agreed the timeline for the soft launch. Analyse the audio:\n- 00:00 - 00:46: Male speaker discussing the timeline.\nKeywords to check: KSITM "ok"Okay. And the user manual follows the sign off.' },
    { t: 405, c: 400, dur: 150, src: 'others', text: 'Speaker 1: "Okay, that is fine."\nSpeaker 2: "Then we start on the second of November." Then we start on the second of November.' },
    { t: 560, c: 550, dur: 40, src: 'me', text: 'Noted.' },
    { t: 705, c: 700, dur: 200, src: 'others', text: 'Back after the break, the soft launch stands.' },
  ];
  const base = (extra) => `startedAt: Date.now() - 3600000, endedAt: Date.now() - 1000, errors: [], mom: '', ${extra}`;
  await opts.evaluate(`(async () => {
    await chrome.storage.local.set({
      settings: { llmProvider: 'openai', oaBase: 'http://127.0.0.1:${PORT}/v1', oaModel: 'fake', minutesFormat: 'standard', minutesMode: 'quick', calendarLookup: false, emailAuto: false, voiceOn: false },
      'meeting:gp1': { id: 'gp1', title: 'With a gap', ${base(`segments: ${JSON.stringify(segs)}, pauses: [{ from: 600, to: 700 }]`)} },
      'meeting:gp2': { id: 'gp2', title: 'Whole', ${base(`segments: ${JSON.stringify([{ t: 3, c: 0, dur: 150, src: 'others', text: 'All of it was said.' }, { t: 160, c: 150, dur: 150, src: 'others', text: 'And continued here.' }])}`)} },
      'meeting:gp3': { id: 'gp3', title: 'Found while recording', ${base(`segments: ${JSON.stringify([{ t: 3, c: 0, dur: 150, src: 'others', text: 'Start.' }, { t: 160, c: 150, dur: 150, src: 'others', text: 'More.' }])}, gaps: [{ t: 150, dur: 150, voicedSec: 120, chars: 20 }], silences: [{ t: 400, dur: 100 }]`)} },
      meetingIds: ['gp3', 'gp2', 'gp1'],
    });
  })()`);

  // 1. the minutes page for the meeting with a gap
  const p1 = await openPage(`chrome-extension://${id}/mom.html?id=gp1`);
  const v1 = await p1.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#transcript .seg')].map((r) => ({ t: r.children[0].textContent, who: r.children[1].textContent, text: r.children[2].textContent }));
    const err = document.getElementById('errors');
    return { rows, errHidden: err.classList.contains('hidden'), errText: err.textContent, body: document.body.innerText };
  })()`);
  const gapRows = v1.rows.filter((r) => r.who === 'Gap');
  const said = v1.rows.map((r) => r.text).join(' '); // the transcript panel may be collapsed, so its rows are read, not the page's visible text
  check('the transcript has one Gap note, where nothing was transcribed (02:30 to 06:45)', gapRows.length === 1 && /02:30/.test(gapRows[0].t + gapRows[0].text) && /06:45/.test(gapRows[0].text), JSON.stringify(gapRows));
  check('the pause the person made is a Paused note and not a gap', v1.rows.filter((r) => r.who === 'Paused').length === 1 && v1.rows.filter((r) => r.who === 'Gap').length === 1);
  check('the warning box names the stretch', !v1.errHidden && /No transcript for 02:30–06:4\d/.test(v1.errText), v1.errText);
  check('notes about the audio never reach the page', v1.rows.length >= 5 && !/Silent audio track|Analyse the audio|Keywords to check|Output: Nothing|Speaker 1:|Speaker 2:|00:00 - 00:46/.test(said + v1.body), said.slice(0, 300));
  check('the real words stay, and are said once', /We agreed the timeline for the soft launch/.test(said) && /user manual follows the sign off/.test(said) && (said.match(/start on the second of November/g) || []).length === 1, JSON.stringify(v1.rows.map((r) => r.text)));

  // 2. a meeting with no gap shows nothing extra
  const p2 = await openPage(`chrome-extension://${id}/mom.html?id=gp2`);
  const v2 = await p2.evaluate(`({ gapRows: [...document.querySelectorAll('#transcript .seg .who')].filter((w) => w.textContent === 'Gap').length, errHidden: document.getElementById('errors').classList.contains('hidden') })`);
  check('a whole transcript has no Gap note and no warning', v2.gapRows === 0 && v2.errHidden, JSON.stringify(v2));

  // 3. a gap found while recording is shown, a silent stretch recorded beside it is not
  const p3 = await openPage(`chrome-extension://${id}/mom.html?id=gp3`);
  const v3 = await p3.evaluate(`({ gaps: [...document.querySelectorAll('#transcript .seg')].filter((r) => r.children[1].textContent === 'Gap').map((r) => r.children[0].textContent + ' ' + r.children[2].textContent), err: document.getElementById('errors').textContent })`);
  check('a gap the recorder reported is shown (02:30 to 05:00); the silent piece is not', v3.gaps.length === 1 && /02:30/.test(v3.gaps[0]) && /05:00/.test(v3.gaps[0]) && !/06:40/.test(v3.err), JSON.stringify(v3));

  // 4. the minutes say it too
  const r = await opts.evaluate(`chrome.runtime.sendMessage({ target: 'bg', type: 'job-run', id: 'gp1', force: true })`);
  check('the minutes job starts', r?.ok, JSON.stringify(r));
  let m;
  for (let i = 0; i < 60; i++) {
    m = await opts.evaluate(`chrome.storage.local.get('meeting:gp1').then((x) => x['meeting:gp1'])`);
    if (m?.job?.state === 'done' || m?.job?.state === 'failed') break;
    await sleep(1000);
  }
  check('the minutes were written', m?.job?.state === 'done', JSON.stringify(m?.job));
  check('the minutes carry a coverage warning that names the stretch', /Coverage warning/.test(m?.mom || '') && /02:30–06:4\d/.test(m?.mom || ''), (m?.mom || '').slice(-400));
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
