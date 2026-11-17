// The recorder (offscreen.js) run in Node with a fake browser: synthetic audio goes in, fake speech-to-text answers come back, and we
// check what is sent to the service worker: the text with where it came from, notes about silent pieces, and gaps.
import assert from 'node:assert/strict';
import { SR } from '../src/chunker.js';
import { DEFAULTS } from '../src/store.js';

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
};

// ---- a fake browser ----
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
let addModule = async () => {};
globalThis.AudioContext = class {
  constructor() {
    this.state = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: (u) => addModule(u) };
    ctxs.push(this);
  }
  resume() {
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
    this.closed = true;
    return Promise.resolve();
  }
};
// every track ever handed out, to see that none is left running after a failed or stopped start
let tracks = [];
const fakeStream = () => {
  const mine = [{ addEventListener() {}, readyState: 'live', muted: false, enabled: true, stop() { this.stopped = true; } }];
  tracks.push(...mine);
  return { getAudioTracks: () => mine, getVideoTracks: () => [], getTracks: () => mine };
};
let getUserMedia = async () => fakeStream();
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: (c) => getUserMedia(c) } }, configurable: true });
// timers: count the intervals that were set and not cleared
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveTimers = new Set();
globalThis.setInterval = (...a) => {
  const h = realSetInterval(...a);
  liveTimers.add(h);
  return h;
};
globalThis.clearInterval = (h) => {
  liveTimers.delete(h);
  return realClearInterval(h);
};

// a voice worker we can hold back, fail or count closes of
const voice = { mode: 'ok', gate: null, closed: 0 };
globalThis.Worker = class {
  postMessage(m) {
    if (m?.type !== 'init') return;
    if (voice.mode === 'fail') setTimeout(() => this.onerror?.({ message: 'no model' }), 0);
    else Promise.resolve(voice.gate).then(() => this.onmessage?.({ data: { ready: true } }));
  }
  terminate() {
    voice.closed++;
  }
};

// ---- fake speech-to-text: the answer depends on how long the audio is ----
let requests = [];
let answer = () => '';
let verbose = null; // when set, the OpenAI-compatible path answers with this verbose_json body
globalThis.fetch = async (url, init = {}) => {
  if (init.body === undefined) return new Response(new Uint8Array(16)); // the voice model file
  if (init.body instanceof FormData) {
    const sec = (init.body.get('file').size - 44) / 32000;
    requests.push(sec);
    return Response.json(typeof verbose === 'function' ? verbose(sec) : verbose);
  }
  const body = JSON.parse(init.body);
  const b64 = body.contents[0].parts.find((p) => p.inlineData).inlineData.data;
  const sec = (Buffer.from(b64, 'base64').length - 44) / 32000;
  requests.push(sec);
  const text = answer(sec, requests.length);
  return Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
};

await import('../src/offscreen.js');
const words = (n) => Array.from({ length: n }, (_, i) => `point${i}`).join(' '); // not a loop of one word: the speech layer drops those as noise
const BLOCK = 2048;

const rpc = (msg) => new Promise((resolve) => (onMessage({ target: 'offscreen', ...msg }, {}, resolve) === true ? 0 : 0));
const feed = (node, sec, amp) => {
  for (let n = 0; n < (sec * SR) / BLOCK; n++) {
    const b = new Float32Array(BLOCK);
    if (amp) for (let i = 0; i < BLOCK; i++) b[i] = amp * Math.sin((2 * Math.PI * 220 * (n * BLOCK + i)) / SR);
    node.port.onmessage({ data: b });
  }
};
let settings = { ...DEFAULTS, sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'gemini-3.8-flash', geminiModel: 'gemini-3.8-flash', captureMic: false };

async function record(meetingId, play) {
  sent = [];
  requests = [];
  nodes = [];
  const r = await rpc({ type: 'start', streamId: 's', settings, meetingId });
  assert.equal(r.ok, true, JSON.stringify(r));
  play(nodes[0]);
  await rpc({ type: 'stop' });
  return { segments: sent.filter((m) => m.type === 'segment').map((m) => m.seg), gaps: sent.filter((m) => m.type === 'gap').map((m) => m.gap), silences: sent.filter((m) => m.type === 'silence'), dbg: sent.filter((m) => m.type === 'dbg').map((m) => m.note), errors: sent.filter((m) => m.type === 'stt-error') };
}

await test('a healthy answer: one request per piece, the text goes on with where it came from, nothing is reported', async () => {
  answer = () => words(400); // 2000 characters for ~2 minutes of speech
  const r = await record('m1', (n) => {
    feed(n, 110, 0.1);
    feed(n, 0.5, 0); // a pause: the piece is cut here
    feed(n, 30, 0.1);
  });
  assert.equal(requests.length, 2, `requests: ${requests}`); // two pieces, one request each
  assert.equal(r.segments.length, 2);
  const [a, b] = [...r.segments].sort((x, y) => x.c - y.c); // the short piece is answered first
  assert.equal(a.c, 0);
  assert.ok(Math.abs(a.dur - 110.5) < 1, String(a.dur));
  assert.ok(b.c > 100 && b.dur > 25);
  assert.equal(r.gaps.length, 0);
  assert.equal(r.errors.length, 0);
});

await test('a long piece answered with one word is read again in parts, and the parts are what goes on', async () => {
  answer = (sec) => (sec > 60 ? 'Okay.' : words(100));
  const r = await record('m2', (n) => feed(n, 140, 0.1));
  assert.ok(requests.length >= 4, `requests: ${requests}`);
  assert.ok(requests[0] > 100 && requests.slice(1).every((s) => s < 60), String(requests));
  assert.equal(r.gaps.length, 0, JSON.stringify(r.gaps));
  assert.ok(r.segments.length === 1 && r.segments[0].text.length > 1000, JSON.stringify(r.segments.map((s) => s.text.length)));
  assert.ok(r.dbg.some((d) => /looks incomplete/.test(d)));
});

await test('a piece nothing can read is reported once as a gap with where and how long, and the thin text still goes on', async () => {
  answer = () => 'Okay.';
  const r = await record('m3', (n) => feed(n, 140, 0.1));
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].t, 0);
  assert.ok(Math.abs(r.gaps[0].dur - 140) < 1 && r.gaps[0].voicedSec >= 100, JSON.stringify(r.gaps[0]));
  assert.ok(r.gaps[0].chars < 100);
  assert.equal(r.segments.length, 1);
});

await test('a silent stretch is skipped with no request, and remembered so it is not taken for a gap', async () => {
  answer = () => words(400);
  const r = await record('m4', (n) => feed(n, 30, 0));
  assert.equal(requests.length, 0);
  assert.equal(r.segments.length, 0);
  assert.equal(r.silences.length, 1);
  assert.equal(r.silences[0].t, 0);
  assert.ok(Math.abs(r.silences[0].dur - 30) < 1, String(r.silences[0].dur));
  assert.equal(r.gaps.length, 0);
});

await test('a failing request keeps the audio for a retry and says so (no gap is reported for it)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"message":"Request contains an invalid argument."}}', { status: 400 });
  try {
    const r = await record('m5', (n) => feed(n, 30, 0.1));
    assert.equal(r.segments.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /HTTP 400.*\((audio kept|audio could not be kept)/);
    assert.equal(r.gaps.length, 0);
  } finally {
    globalThis.fetch = real;
  }
});

const gemini = settings;
const oaSettings = { ...DEFAULTS, sttProvider: 'openai', sttBase: 'http://localhost:9000/v1', sttModel: 'm', captureMic: false };

await test('timed utterances become segments with their own times, and the piece start and length stay on each', async () => {
  settings = oaSettings;
  verbose = { text: 'One. Two. Three.', segments: [{ start: 1, end: 3, text: 'One.' }, { start: 3.2, end: 5, text: 'Two.' }, { start: 12, end: 14, text: 'Three.' }] };
  const r = await record('m6', (n) => feed(n, 20, 0.1));
  assert.deepEqual(r.segments.map((s) => [s.t, s.text, s.u]), [[1, 'One. Two.', 1], [12, 'Three.', 1]]);
  assert.ok(r.segments.every((s) => s.c === 0 && Math.abs(s.dur - 20) < 1));
});

await test('no utterances from the provider: the old single segment at the piece start', async () => {
  verbose = { text: 'Just text here.' };
  const r = await record('m7', (n) => feed(n, 20, 0.1));
  assert.deepEqual(r.segments.map((s) => [s.t, s.text, s.u]), [[0, 'Just text here.', undefined]]);
});

await test('utterances in a second piece are placed after the first piece, each with its own c', async () => {
  verbose = (sec) => ({ text: 'Hi there.', segments: [{ start: 2, end: 4, text: 'Hi there.' }] });
  const r = await record('m8', (n) => feed(n, 40, 0.1)); // cut at the 28 s maximum: two pieces
  const segs = [...r.segments].sort((x, y) => x.t - y.t);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => s.t), [2, segs[1].c + 2]);
  assert.ok(segs[1].c > 25 && segs.every((s) => s.u === 1));
});

await test('features off (the defaults): the tab is asked for audio exactly once, with the same constraints as always, and nothing else is started', async () => {
  settings = gemini;
  const calls = [];
  const real = getUserMedia;
  getUserMedia = async (c) => (calls.push(c), real(c));
  try {
    await record('m9', (n) => feed(n, 3, 0.1));
  } finally {
    getUserMedia = real;
  }
  assert.deepEqual(calls, [{ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 's' } }, video: false }]);
});

await test('one mixed stream (Gemini with the microphone): stopping while the mixer still holds audio does not throw', async () => {
  settings = { ...gemini, captureMic: true };
  answer = () => words(100);
  const r = await record('m10', (n) => feed(n, 3, 0.1));
  assert.equal(r.errors.length, 0);
});

// ---- a start that fails or is stopped half-way leaves nothing behind (fix 3) ----
const clean = (what) => {
  assert.ok(tracks.length > 0, 'a stream was made');
  assert.ok(tracks.every((t) => t.stopped), `${what}: every track stopped`);
  assert.ok(ctxs.every((c) => c.closed), `${what}: every audio context closed`);
  assert.equal(liveTimers.size, 0, `${what}: no interval left (${liveTimers.size})`);
};
const fresh = () => {
  sent = [];
  nodes = [];
  tracks = [];
  ctxs = [];
};
const startOk = async (id, extra = {}) => {
  const r = await rpc({ type: 'start', streamId: 's', settings: { ...gemini, ...extra }, meetingId: id });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};

await test('addModule throws: the start fails, every track is stopped, the contexts closed, and the next start works', async () => {
  settings = gemini;
  fresh();
  addModule = async () => {
    throw new Error('worklet failed');
  };
  const r = await rpc({ type: 'start', streamId: 's', settings: { ...gemini, captureMic: true }, meetingId: 'f1' });
  addModule = async () => {};
  assert.equal(r.ok, false);
  assert.match(r.error, /worklet failed/);
  clean('failed start');
  fresh();
  await startOk('f2');
  await rpc({ type: 'stop' });
  clean('second recording');
});

await test('a failed start leaves no recording: the second start is not refused as "Already recording"', async () => {
  fresh();
  let n = 0;
  getUserMedia = async (c) => {
    if (c.video === false && n++ === 0) throw new Error('permission');
    return fakeStream();
  };
  const r = await rpc({ type: 'start', streamId: 's', settings: gemini, meetingId: 'f3' });
  getUserMedia = async () => fakeStream();
  assert.equal(r.ok, false);
  await startOk('f4');
  await rpc({ type: 'stop' });
});

await test('the tap throwing after the recording exists is undone the same way', async () => {
  fresh();
  const real = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      throw new Error('no worklet node');
    }
  };
  const r = await rpc({ type: 'start', streamId: 's', settings: { ...gemini, captureMic: true }, meetingId: 'f5' });
  globalThis.AudioWorkletNode = real;
  assert.equal(r.ok, false);
  clean('tap failed');
  fresh();
  await startOk('f6');
  await rpc({ type: 'stop' });
});

await test('after stop the late audio blocks are ignored by the microphone tap (it used to throw on every block)', async () => {
  fresh();
  await startOk('f7', { captureMic: true });
  const [tab, mic] = nodes;
  await rpc({ type: 'stop' });
  assert.doesNotThrow(() => feed(mic, 0.5, 0.1));
  assert.doesNotThrow(() => feed(tab, 0.5, 0.1));
});

// MediaRecorder fake for the kept-recording path
class FakeRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor() {
    FakeRecorder.made++;
    if (FakeRecorder.failFrom != null && FakeRecorder.made > FakeRecorder.failFrom) throw new Error('stream is dead');
  }
  start() {}
  stop() {
    setTimeout(() => this.onstop?.(), 0);
  }
}
FakeRecorder.made = 0;

await test('stop() while the kept recording is still starting: no exception, no timer left, and a second start works', async () => {
  fresh();
  globalThis.MediaRecorder = FakeRecorder;
  const gate = {};
  const slow = new Promise((r) => (gate.open = r));
  const realIdb = globalThis.indexedDB;
  // listSegs (the first await inside startKeeping) waits until we say so
  globalThis.indexedDB = { open: () => { const q = {}; slow.then(() => q.onerror?.()); Object.defineProperty(q, 'error', { value: new Error('idb') }); return q; } };
  const started = rpc({ type: 'start', streamId: 's', settings: { ...gemini, keepAudio: true }, meetingId: 'k1' });
  await new Promise((r) => setTimeout(r, 20));
  await rpc({ type: 'stop' });
  gate.open();
  const r = await started;
  globalThis.indexedDB = realIdb;
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped while it was starting/);
  clean('stop during setupKeep');
  fresh();
  await startOk('k2');
  await rpc({ type: 'stop' });
  clean('after');
});

await test('stop() while the voice model loads: no exception, the worker is closed, no timer is left, and a second start works', async () => {
  fresh();
  voice.closed = 0;
  let release;
  voice.gate = new Promise((r) => (release = r));
  const started = rpc({ type: 'start', streamId: 's', settings: { ...gemini, voiceLearn: true }, meetingId: 'v1' });
  await new Promise((r) => setTimeout(r, 30));
  await rpc({ type: 'stop' });
  release();
  const r = await started;
  voice.gate = null;
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped while it was starting/);
  assert.ok(voice.closed >= 1, 'the voice client was closed');
  clean('stop during startVoice');
  fresh();
  await startOk('v2');
  await rpc({ type: 'stop' });
});

await test('a voice model that cannot load closes its client and the recording goes on without voices', async () => {
  fresh();
  voice.closed = 0;
  voice.mode = 'fail';
  await startOk('v3', { voiceLearn: true });
  voice.mode = 'ok';
  assert.equal(voice.closed, 1);
  await rpc({ type: 'stop' });
  clean('voice failed');
});

await test('a content script cannot message the offscreen document; the service worker and extension pages can', async () => {
  const send = (msg, sender) => new Promise((resolve) => {
    const r = onMessage({ target: 'offscreen', ...msg }, sender, resolve);
    if (r !== true) setTimeout(() => resolve('ignored'), 30);
  });
  assert.equal(await send({ type: 'job-count' }, { tab: { id: 3 }, url: 'https://meet.google.com/abc-defg-hij' }), 'ignored');
  assert.equal(await send({ type: 'stop' }, { tab: { id: 3 }, url: 'https://evil.example/' }), 'ignored');
  assert.deepEqual(await send({ type: 'job-count' }, {}), { ok: true, count: 0 });
  assert.deepEqual(await send({ type: 'job-count' }, { tab: { id: 4 }, url: 'chrome-extension://debrief/minutes.html' }), { ok: true, count: 0 });
});

await test('resuming after a pause when the kept recorder cannot restart: the handler still answers, the failure is reported once, keeping stops, the recording goes on', async () => {
  fresh();
  FakeRecorder.made = 0;
  FakeRecorder.failFrom = null;
  globalThis.MediaRecorder = FakeRecorder;
  await startOk('p1', { keepAudio: true });
  FakeRecorder.failFrom = FakeRecorder.made; // every recorder made from now on throws
  const answered = (msg) => Promise.race([rpc(msg), new Promise((r) => setTimeout(() => r('NO REPLY'), 500))]);
  assert.deepEqual(await answered({ type: 'pause', on: true }), { ok: true, paused: true });
  assert.deepEqual(await answered({ type: 'pause', on: false }), { ok: true, paused: false });
  assert.deepEqual(await answered({ type: 'pause', on: true }), { ok: true, paused: true });
  assert.deepEqual(await answered({ type: 'pause', on: false }), { ok: true, paused: false });
  const notes = sent.filter((m) => m.type === 'dbg' && /kept recording stopped/.test(m.note));
  assert.equal(notes.length, 1, JSON.stringify(notes));
  await rpc({ type: 'stop' });
  FakeRecorder.failFrom = null;
  clean('pause failure');
});

settings = gemini;
console.log(`\n${passed} passed`);
