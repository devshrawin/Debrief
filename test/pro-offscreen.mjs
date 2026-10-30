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
    getURL: (p) => p,
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
globalThis.AudioContext = class {
  constructor() {
    this.state = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
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
  close() {
    return Promise.resolve();
  }
};
const fakeStream = () => ({ getAudioTracks: () => [{ addEventListener() {}, readyState: 'live', muted: false, enabled: true }], getTracks: () => [{ stop() {} }] });
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => fakeStream() } }, configurable: true });

// ---- fake speech-to-text: the answer depends on how long the audio is ----
let requests = [];
let answer = () => '';
globalThis.fetch = async (url, init = {}) => {
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
const settings = { ...DEFAULTS, sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'gemini-3.8-flash', geminiModel: 'gemini-3.8-flash', captureMic: false };

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

console.log(`\n${passed} passed`);
