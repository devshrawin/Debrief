// Real Chrome: the glass layer on every page: the moving colour room, orbs for waiting, the border beam on search, liquid
// controls, and the calm settings (reduced motion, reduce transparency). Usage: node test/chrome-glass.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const profile = mkdtempSync(path.join(tmpdir(), 'debrief-glass-'));

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
  const opts = await openPage(`chrome-extension://${id}/options.html`);
  await opts.evaluate(`chrome.storage.local.set({
    schema: 2,
    settings: { llmProvider: 'gemini', geminiKey: 'k', geminiModel: 'm', minutesFormat: 'standard' },
    'meeting:g1': { id: 'g1', title: 'Glass', startedAt: Date.now() - 600000, endedAt: Date.now() - 1000, segments: [{ t: 3, src: 'me', text: 'Hello.' }], errors: [], mom: '', decided: true,
      job: { state: 'writing', status: 'Reading the transcript carefully (part 1 of 2)…', beat: Date.now() + 600000 } },
    meetingIds: ['g1'] })`);

  // 1. every page: the moving colour room, the glass switch and the fx layer
  for (const pg of ['popup', 'mom', 'options', 'welcome', 'ask']) {
    const p = await openPage(`chrome-extension://${id}/${pg}.html${pg === 'mom' ? '?id=g1' : ''}`);
    await sleep(900);
    const r = await p.evaluate(`(() => {
      const bg = document.querySelector('.fx-bg');
      const b1 = bg && bg.querySelector('.b1');
      return { blobs: bg ? bg.children.length : 0, anim: b1 ? getComputedStyle(b1).animationName : 'none', glass: document.documentElement.classList.contains('glass'),
        fx: [...document.scripts].some((s) => s.src.includes('fx/fx-${pg}.js')), fixed: bg ? getComputedStyle(bg).position : '' };
    })()`);
    if (pg === 'popup') {
      // the room really moves: a blob is somewhere else a couple of seconds later (this page is the one in front)
      const mv = await p.evaluate(`(async () => { const bg = document.querySelector('.fx-bg .b1'); const a = getComputedStyle(bg).transform; await new Promise((r) => setTimeout(r, 2500)); return { a, b: getComputedStyle(bg).transform }; })()`);
      check('the colour room moves over time', mv.a !== mv.b && mv.a !== 'none', JSON.stringify(mv));
    }
    check(`${pg}: fluid colour room (6 blobs, animated), glass on, effects loaded`, r.blobs === 6 && /fx-d1/.test(r.anim) && r.glass && r.fx && r.fixed === 'fixed', JSON.stringify(r));
  }

  // 2. popup: liquid tabs; the Meetings search carries the border beam while focused
  const pop = await openPage(`chrome-extension://${id}/popup.html`);
  await sleep(1200);
  const pp = await pop.evaluate(`(async () => {
    const out = { goo: !!document.querySelector('#tabs.has-goo svg.goo-layer'), mode: !!document.querySelector('#modeSeg.has-goo') };
    document.getElementById('tabMeet').click();
    await new Promise((r) => setTimeout(r, 300));
    const sw = document.querySelector('.searchwrap');
    document.getElementById('q').focus();
    await new Promise((r) => setTimeout(r, 400));
    out.beamOn = sw.hasAttribute('data-beam') && sw.hasAttribute('data-active');
    document.getElementById('q').blur();
    await new Promise((r) => setTimeout(r, 400));
    out.beamOff = !sw.hasAttribute('data-active');
    return out;
  })()`);
  check('popup: liquid tabs and mode switch; the search glows with the border beam only while focused', pp.goo && pp.mode && pp.beamOn && pp.beamOff, JSON.stringify(pp));

  // 3. the minutes page while a job writes: an orb for the wait, the toolbar glows
  const mom = await openPage(`chrome-extension://${id}/mom.html?id=g1`);
  await sleep(2000);
  const mm = await mom.evaluate(`({ orb: document.querySelectorAll('db-orb').length, beam: document.querySelector('.toolbar')?.hasAttribute('data-beam'), spin: document.querySelectorAll('.spin:not([data-orbed])').length, status: document.getElementById('genStatus').textContent })`);
  check('minutes page: writing shows a thinking orb and the toolbar beam, no plain spinner', mm.orb >= 1 && mm.beam && mm.spin === 0, JSON.stringify(mm));

  // 4. any spinner the pages add later becomes an orb
  const sp = await mom.evaluate(`(async () => {
    const before = document.querySelectorAll('db-orb').length;
    const s = document.createElement('span');
    s.className = 'spin';
    document.getElementById('genStatus').after(s);
    await new Promise((r) => setTimeout(r, 300));
    return { more: document.querySelectorAll('db-orb').length - before, left: document.querySelectorAll('.spin:not([data-orbed])').length };
  })()`);
  check('a spinner added later is swapped for an orb', sp.more >= 1 && sp.left === 0, JSON.stringify(sp));

  // 5. Ask page: the question box glows while focused
  const ask = await openPage(`chrome-extension://${id}/ask.html`);
  await sleep(1000);
  const ak = await ask.evaluate(`(async () => {
    const box = document.getElementById('askBox');
    box.querySelector('input').focus();
    await new Promise((r) => setTimeout(r, 400));
    return { on: box.hasAttribute('data-beam') && box.hasAttribute('data-active') };
  })()`);
  check('Ask page: the question box carries the beam while focused', ak.on, JSON.stringify(ak));

  // 6. calm: reduced motion stops the room; "Reduce transparency" removes it
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, ask.sessionId);
  await sleep(300);
  const rm = await ask.evaluate(`getComputedStyle(document.querySelector('.fx-bg .b1')).animationName`);
  check('reduced motion: the colour room holds still', rm === 'none', rm);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, ask.sessionId);
  await opts.evaluate(`chrome.storage.local.set({ uiSolid: true })`);
  await sleep(800);
  const so = await ask.evaluate(`({ solid: document.documentElement.classList.contains('solid'), hidden: getComputedStyle(document.querySelector('.fx-bg')).display === 'none' })`);
  check('Reduce transparency: solid surfaces, no moving room', so.solid && so.hidden, JSON.stringify(so));
} catch (e) {
  console.log('FAIL', e.stack);
  failed = true;
} finally {
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}
