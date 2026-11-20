// Regression tests for the pages-and-capture audit (round 2, items C1-C14 and the UI items): a due date is reformatted only
// when the whole cell is a date, empty table cells lose their label, the usage day arithmetic, the re-read dialog's request
// count, a screen watcher that gives up on a refused key, the pill (the Discard confirmation survives rebuilds, meters update
// in place, no button inside a button, the muted mic style) and the recorder (a new recording never gets an old one's audio, a
// suspended audio context is resumed once). The pages themselves (minutes, live, settings, voices) are covered by the chrome-*
// suites. Usage: node test/pro-fixes-f.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as esbuild from 'esbuild';

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 6).join('\n     ')}`);
    process.exitCode = 1;
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- C6: fmtDue only reformats a cell that is a date and nothing else ----
const { fmtDue } = await import('../src/datefmt.js');
const REF = Date.UTC(2025, 10, 1); // a meeting held on 1 Nov 2025

await test('C6 a Due cell that only contains a date is reformatted; a cell with other words keeps its text', () => {
  assert.equal(fmtDue('By end of week, 5 Dec', REF), 'By end of week, 5 Dec');
  assert.equal(fmtDue('6 marketing tasks', REF), '6 marketing tasks');
  assert.equal(fmtDue('6 marketing', REF), '6 marketing');
  assert.equal(fmtDue('Before 5 Dec', REF), 'Before 5 Dec');
  assert.equal(fmtDue('Not stated', REF), 'Not stated');
  assert.equal(fmtDue('next sprint', REF), 'next sprint');
  assert.equal(fmtDue('2026-10-16', REF), '16 Oct 2026');
  assert.equal(fmtDue('16/10/2026', REF), '16 Oct 2026');
  assert.equal(fmtDue('16-Oct-26', REF), '16 Oct 2026');
  assert.equal(fmtDue('Oct 16, 2026', REF), '16 Oct 2026');
  assert.equal(fmtDue(' 5th December 2025 ', REF), '5 Dec 2025');
  assert.equal(fmtDue('5 Dec', REF), '5 Dec 2025');
});

await test('C6 a year-less date takes the year of the meeting it came from, not the current year', () => {
  assert.equal(fmtDue('5 Dec', Date.UTC(2023, 10, 1)), '5 Dec 2023');
  assert.equal(fmtDue('5 Dec', Date.UTC(2031, 10, 1)), '5 Dec 2031');
});

// ---- the minutes tables (md.js) in a DOM: C6 through decorateMinutes, U4 empty cells ----
const dom = new JSDOM('<!doctype html><body></body>', { virtualConsole: new VirtualConsole() });
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
const { renderMd, decorateMinutes } = await import('../src/md.js');
const tableRoot = (md) => {
  const root = document.createElement('div');
  root.innerHTML = renderMd(md);
  return root;
};

await test('C6 decorateMinutes formats a Due cell that is a date with the meeting year, and leaves other text as written', () => {
  const root = tableRoot('| Action | Owner | Due |\n|---|---|---|\n| One | Amal | By end of week, 5 Dec |\n| Two | Amal | 5 Dec |\n| Three | Amal | 6 marketing tasks |\n');
  decorateMinutes(root, REF);
  const dues = [...root.querySelectorAll('td[data-label="Due"]')].map((c) => c.textContent);
  assert.deepEqual(dues, ['By end of week, 5 Dec', '5 Dec 2025', '6 marketing tasks']);
});

await test('U4 an empty cell of a stacked table is a truly empty cell, which the stylesheet hides so no bare label ("Note:") shows', () => {
  const root = tableRoot('| Person | Present | Note |\n|---|---|---|\n| Amal | Yes |   |\n| Priya | Absent | Late |\n');
  decorateMinutes(root, REF);
  const rows = [...root.querySelectorAll('tbody tr')];
  const empty = rows[0].cells[2];
  assert.equal(empty.textContent, '');
  assert.equal(empty.matches(':empty'), true, 'a cell with no content at all, which the stylesheet hides when stacked');
  assert.equal(rows[1].cells[2].getAttribute('data-label'), 'Note');
  const css = readFileSync(new URL('../extension/mom.css', import.meta.url), 'utf8');
  assert.match(css, /table\[data-stack\] td:empty\s*\{\s*display:\s*none/);
});

// ---- C14: usage ----
const U = await import('../src/usage.js');

await test('C14 a day is counted once across a clock change (calendar days, not 24-hour steps)', () => {
  // Pacific time fell back on 1 Nov 2026: that day has 25 hours. 23:30 on the 1st, looked back 24 h, is still the 1st.
  const now = new Date('2026-11-02T07:30:00Z');
  assert.equal(U.dayKey(now), '2026-11-01');
  const usage = { '2026-11-01': { 'gemini|m|llm': { req: 5 } }, '2026-10-31': { 'gemini|m|llm': { req: 7 } } };
  const rows = U.summarize(usage, 2, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].req, 12, 'the 1st (5) and the 31st (7), each once');
  assert.equal(U.shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(U.shiftDay('2026-01-01', -1), '2025-12-31');
  // and a week across the spring change
  const spring = U.summarize({ '2026-03-07': { 'a|b|c': { req: 1 } }, '2026-03-08': { 'a|b|c': { req: 2 } }, '2026-03-09': { 'a|b|c': { req: 4 } } }, 3, new Date('2026-03-09T20:00:00Z'));
  assert.equal(spring[0].req, 7);
});

await test('C14 nextQuotaReset finds midnight Pacific without building a formatter per probe', () => {
  const RealDTF = Intl.DateTimeFormat;
  let made = 0;
  Intl.DateTimeFormat = new Proxy(RealDTF, { construct: (t, a) => (made++, new t(...a)) });
  try {
    const now = Date.UTC(2026, 10, 1, 20, 0, 0); // 12:00 Pacific on 1 Nov
    const at = U.nextQuotaReset(now);
    assert.equal(U.dayKey(new Date(at)), '2026-11-02');
    assert.equal(U.dayKey(new Date(at - 60000)), '2026-11-01');
    assert.ok(at - now <= 13 * 3600000 && at > now);
    assert.ok(made <= 2, `formatters built: ${made}`);
  } finally {
    Intl.DateTimeFormat = RealDTF;
  }
});

// ---- C13: the re-read dialog says what it will send, and caps a long stretch ----
const L = await import('../src/actionslogic.js');
await test('C13 the re-read note counts the requests and says when only the first 30 minutes are read', () => {
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  assert.match(L.rereadNote(0, 18, 18, 1, fmt), /\(one request\)/);
  assert.match(L.rereadNote(0, 300, 300, 5, fmt), /about 5 requests/);
  assert.doesNotMatch(L.rereadNote(0, 300, 300, 5, fmt), /first 30 minutes/);
  const to = Math.min(7200, L.MAX_REREAD_PARTS * 60);
  const note = L.rereadNote(0, to, 7200, L.splitSpan(0, to).length, fmt);
  assert.match(note, /about 30 requests/);
  assert.match(note, /only the first 30 minutes are read/);
  assert.equal(L.splitSpan(0, to).length, 30);
});

// ---- C8: a refused key stops the screen notes for the recording ----
const S = await import('../src/screen.js');
const rgba = (w, h, grey) => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set([grey(x, y), grey(x, y), grey(x, y), 255], (y * w + x) * 4);
  return a;
};
const fakeCanvasKit = (state) => (w, h) => ({
  canvas: {},
  width: w,
  height: h,
  ctx: { drawImage() {}, getImageData: () => ({ data: state.pixels }) },
  toBlob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
});
const video = () => ({ videoWidth: 1920, videoHeight: 1080 });

await test('C8 a request that cannot succeed (retryable: false) stops the watcher once and says why; a retryable one keeps trying', async () => {
  const state = { pixels: rgba(16, 16, (x) => (x < 8 ? 230 : 20)) };
  let clock = 10_000;
  let asked = 0;
  const said = [];
  const w = new S.ScreenWatcher({ video: video(), everySec: 5, now: () => clock, makeCanvas: fakeCanvasKit(state), onGiveUp: (why) => said.push(why), onFrame: async () => (asked++, { error: 'HTTP 401: bad key', retryable: false }) });
  const tickAt = async (sec) => {
    clock = 10_000 + sec * 1000;
    return w.tick();
  };
  await tickAt(5);
  await tickAt(10);
  assert.equal(asked, 1);
  assert.deepEqual(said, ['HTTP 401: bad key']);
  assert.equal(w.stopped, true);
  for (const s of [40, 100, 400, 1000]) await tickAt(s);
  assert.equal(asked, 1, 'no further request this recording');
  assert.equal(said.length, 1);

  // a retryable error is not a reason to stop
  let n = 0;
  const w2 = new S.ScreenWatcher({ video: video(), everySec: 5, now: () => clock, makeCanvas: fakeCanvasKit({ pixels: state.pixels }), onGiveUp: () => said.push('x'), onFrame: async () => (n++, { error: 'HTTP 429', retryable: true }) });
  clock = 10_000;
  await w2.tick();
  clock = 15_000;
  await w2.tick();
  assert.equal(w2.stopped, undefined);
  assert.equal(said.length, 1);
});

// ---- the pill (C5, C10, C11) in jsdom ----
const bundle = (await esbuild.build({ entryPoints: [fileURLToPath(new URL('../src/pill.js', import.meta.url))], bundle: true, format: 'iife', write: false, logLevel: 'silent' })).outputFiles[0].text;
const recState = (o = {}) => ({ recording: true, meetingId: 'm1', tabId: 7, startedAt: Date.now() - 3000, mic: true, micOn: true, micWanted: true, ...o });
const baseS = (o = {}) => ({ ok: true, rec: recState(), levels: { at: Date.now() + 1e7, tab: 0.01, mic: 0.01 }, counts: { segs: 1, errs: 0 }, follow: true, showPill: true, captionMode: 'read', otherSites: true, shortcut: 'Ctrl+Shift+Y', notice: { on: false, text: '', done: false }, nudge: { on: false, skipOneOnOne: true, meetingTypes: [], dismissed: [] }, ...o });
function pillPage(S) {
  const win = new JSDOM('<!doctype html><title>Daily standup - Google Meet</title><body><button aria-label="Leave call"></button></body>', { url: 'https://meet.google.com/abc-defg-hij', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: new VirtualConsole() }).window;
  const sent = [];
  win.chrome = {
    runtime: {
      id: 'testid',
      onMessage: { addListener() {} },
      async sendMessage(m) {
        if (m.type === 'whoami') return { ok: true, tabId: 7 };
        if (m.type === 'pill-state') return JSON.parse(JSON.stringify(S));
        sent.push(JSON.parse(JSON.stringify(m)));
        return { ok: true };
      },
    },
  };
  win.eval(bundle);
  const root = () => win.document.querySelector('[data-debrief]')?.__debriefRoot;
  return { win, sent, root, close: () => win.close() };
}

await test('C5 the Discard confirmation survives the panel being rebuilt while someone speaks', async () => {
  const S = baseS();
  const p = pillPage(S);
  await wait(1300);
  const root = p.root();
  root.querySelector('.toggle').click();
  await wait(300);
  const discard = () => root.querySelector('[data-k="discard"]');
  assert.ok(discard(), 'the panel is open');
  assert.equal(discard().textContent, 'Started by mistake? Discard');
  discard().click();
  assert.equal(discard().textContent, 'Tap again to delete it');
  // something visible changes (a new transcript piece): the panel is rebuilt
  S.counts = { segs: 2, errs: 0 };
  await wait(1400);
  assert.match(root.querySelector('.panel').textContent, /2 transcript pieces/, 'the panel was rebuilt');
  assert.equal(discard().textContent, 'Tap again to delete it', 'still armed');
  assert.equal(p.sent.filter((m) => m.type === 'discard').length, 0);
  discard().click();
  assert.equal(p.sent.filter((m) => m.type === 'discard').length, 1);
  p.close();
});

await test('C5 the level meters change in place: the panel is not rebuilt for a louder voice', async () => {
  const S = baseS();
  const p = pillPage(S);
  await wait(1300);
  const root = p.root();
  root.querySelector('.toggle').click();
  await wait(300);
  const meter = root.querySelector('.meter');
  const before = [meter.querySelector('.w').textContent, meter.querySelector('.m').getAttribute('aria-valuenow')];
  S.levels = { at: Date.now() + 1e7, tab: 0.0001, mic: 0.0001 };
  await wait(1400);
  assert.ok(meter.isConnected, 'the very same meter element is still on screen');
  assert.notDeepEqual([meter.querySelector('.w').textContent, meter.querySelector('.m').getAttribute('aria-valuenow')], before);
  assert.equal(meter.querySelector('.w').textContent, 'Silent');
  p.close();
});

await test('C10 the capsule is not a button holding another button: a real toggle button and the mic button sit side by side', async () => {
  const S = baseS();
  const p = pillPage(S);
  await wait(1300);
  const root = p.root();
  const pill = root.querySelector('.pill');
  assert.equal(pill.getAttribute('role'), null);
  assert.equal(root.querySelector('[role="button"] button'), null);
  const toggle = root.querySelector('button.toggle');
  assert.ok(toggle && toggle.parentElement === pill && root.querySelector('button.mic').parentElement === pill);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click(); // a keyboard press (no pointer): opens the details
  await wait(300);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(root.querySelector('.panel').classList.contains('hidden'), false);
  p.close();
});

await test('C11 a mic muted in the call gets its own style (the stylesheet had .paused, the script uses .muted)', async () => {
  const S = baseS({ rec: recState({ micOn: false, micWanted: true }) });
  const p = pillPage(S);
  await wait(1300);
  const root = p.root();
  assert.equal(root.querySelector('button.mic').classList.contains('muted'), true);
  assert.match(root.querySelector('style').textContent, /\.mic\.muted\s*[,{]/);
  p.close();
});

// ---- the recorder (C14) on a fake browser ----
const { SR } = await import('../src/chunker.js');
const { DEFAULTS } = await import('../src/store.js');
let sent = [];
let onMessage = null;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (f) => (onMessage = f) },
    sendMessage: (m) => (sent.push(m), Promise.resolve({ ok: true })),
    getURL: (p) => `chrome-extension://debrief/${p}`,
  },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
};
let nodes = [];
globalThis.AudioWorkletNode = class {
  constructor() {
    this.port = {};
    nodes.push(this);
  }
  connect(x) {
    return x;
  }
};
let ctxs = [];
globalThis.AudioContext = class {
  constructor() {
    this.state = 'running';
    this.destination = {};
    this.resumed = 0;
    this.audioWorklet = { addModule: async () => {} };
    ctxs.push(this);
  }
  resume() {
    this.resumed++;
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect: (n) => n };
  }
  createGain() {
    return { gain: {}, connect: (x) => x };
  }
  createMediaStreamDestination() {
    return { stream: {} };
  }
  close() {
    return Promise.resolve();
  }
};
const fakeStream = () => {
  const mine = [{ addEventListener() {}, readyState: 'live', muted: false, enabled: true, stop() {} }];
  return { getAudioTracks: () => mine, getVideoTracks: () => [], getTracks: () => mine };
};
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => fakeStream() } }, configurable: true });
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body);
  const b64 = body.contents[0].parts.find((p) => p.inlineData).inlineData.data;
  void b64;
  return Response.json({ candidates: [{ content: { parts: [{ text: Array.from({ length: 80 }, (_, i) => `point${i}`).join(' ') }] } }], usageMetadata: {} });
};
await import('../src/offscreen.js');
const rpc = (msg) => new Promise((resolve) => (onMessage({ target: 'offscreen', ...msg }, {}, resolve), 0));
const BLOCK = 2048;
const feed = (node, sec, amp) => {
  for (let n = 0; n < (sec * SR) / BLOCK; n++) {
    const b = new Float32Array(BLOCK);
    if (amp) for (let i = 0; i < BLOCK; i++) b[i] = amp * Math.sin((2 * Math.PI * 220 * (n * BLOCK + i)) / SR);
    node.port.onmessage({ data: b });
  }
};
const settings = { ...DEFAULTS, sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'gemini-3.8-flash', geminiModel: 'gemini-3.8-flash', captureMic: false };

await test('C14 the old recording\'s audio callback never feeds a recording that started later', async () => {
  sent = [];
  nodes = [];
  assert.equal((await rpc({ type: 'start', streamId: 's', settings, meetingId: 'old' })).ok, true);
  const oldNode = nodes[0];
  await rpc({ type: 'stop' });
  sent = [];
  nodes = [];
  assert.equal((await rpc({ type: 'start', streamId: 's', settings, meetingId: 'new' })).ok, true);
  feed(oldNode, 40, 0.1); // a late block from the first recording's graph, loud enough to be transcribed
  await rpc({ type: 'stop' });
  const segs = sent.filter((m) => m.type === 'segment');
  assert.equal(segs.length, 0, `the new recording heard ${segs.length} piece(s) of the old one's audio`);
});

await test('C14 a context that Chrome suspended mid-meeting is resumed once, and the debug list says what came of it', async () => {
  sent = [];
  nodes = [];
  ctxs = [];
  assert.equal((await rpc({ type: 'start', streamId: 's', settings, meetingId: 'sus' })).ok, true);
  const ctx = ctxs[0];
  const resumedAtStart = ctx.resumed;
  ctx.state = 'suspended';
  await wait(2300);
  assert.equal(ctx.resumed - resumedAtStart, 1, 'resume() tried exactly once');
  const notes = sent.filter((m) => m.type === 'dbg').map((m) => m.note);
  assert.ok(notes.some((n) => /suspended mid-meeting/.test(n) && /resume\(\)/.test(n)), JSON.stringify(notes));
  await rpc({ type: 'stop' });
});

console.log(`\n${passed} passed`);
setTimeout(() => process.exit(process.exitCode || 0), 50);
