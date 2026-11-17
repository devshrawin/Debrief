// Keeping the recording on this computer (src/audiokeep.js + the keep path in offscreen.js), run against an in-memory IndexedDB
// with a fake MediaRecorder and fake audio graph. It shows the bookkeeping, the 30 s segments, pause and failure behaviour;
// it cannot show that a real MediaRecorder produces playable WebM or that Chrome plays the segments back.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import * as K from '../src/audiokeep.js';
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
const blob = (n) => new Blob([new Uint8Array(n)], { type: 'audio/webm' });
const seg = (meetingId, seq, t0, dur, size = 100, savedAt) => ({ meetingId, seq, t0, dur, blob: blob(size), ...(savedAt ? { savedAt } : {}) });

// ---- the store ----
await test('put, list (metadata only), segAt and segRange across segment boundaries', async () => {
  for (const [i, t0] of [0, 30, 60].entries()) await K.putSeg(seg('a', i, t0, 30, 100 + i));
  const list = await K.listSegs('a');
  assert.deepEqual(list.map((s) => [s.seq, s.t0, s.dur, s.bytes]), [[0, 0, 30, 100], [1, 30, 30, 101], [2, 60, 30, 102]]);
  assert.ok(list.every((s) => !('blob' in s)));
  assert.equal((await K.segAt('a', 0)).seq, 0);
  assert.equal((await K.segAt('a', 29.9)).seq, 0);
  assert.equal((await K.segAt('a', 30)).seq, 1); // a boundary belongs to the segment that starts there
  assert.equal((await K.segAt('a', 89)).seq, 2);
  assert.equal(await K.segAt('a', 500), null);
  assert.equal(await K.segAt('nope', 5), null);
  const hit = await K.segAt('a', 31);
  assert.equal(hit.blob.size, 101);
  assert.deepEqual((await K.segRange('a', 20, 40)).map((s) => s.seq), [0, 1]);
  assert.deepEqual((await K.segRange('a', 30, 60)).map((s) => s.seq), [1]);
  assert.deepEqual((await K.segRange('a', 0, 1000)).map((s) => s.seq), [0, 1, 2]);
  assert.deepEqual(await K.segRange('a', 200, 300), []);
});

await test('keptInfo, totalKept, deleteAudio only touches its own meeting', async () => {
  await K.putSeg(seg('b', 0, 0, 12.5, 50));
  assert.deepEqual(await K.keptInfo('a'), { segs: 3, seconds: 90, bytes: 303 });
  assert.deepEqual(await K.keptInfo('b'), { segs: 1, seconds: 13, bytes: 50 });
  assert.deepEqual(await K.keptInfo('zzz'), { segs: 0, seconds: 0, bytes: 0 });
  assert.deepEqual(await K.totalKept(), { meetings: 2, bytes: 353 });
  await K.deleteAudio('a');
  assert.equal((await K.listSegs('a')).length, 0);
  assert.equal((await K.listSegs('b')).length, 1);
  assert.deepEqual(await K.totalKept(), { meetings: 1, bytes: 50 });
  await K.deleteAudio('b');
  assert.deepEqual(await K.totalKept(), { meetings: 0, bytes: 0 });
});

await test('purgeOld deletes segments older than N days; 0 means never', async () => {
  const DAY = 86400000;
  const now = Date.UTC(2026, 10, 16);
  await K.putSeg(seg('old', 0, 0, 30, 10, now - 20 * DAY));
  await K.putSeg(seg('old', 1, 30, 30, 10, now - 15 * DAY));
  await K.putSeg(seg('new', 0, 0, 30, 10, now - 2 * DAY));
  assert.equal(await K.purgeOld(0, now), 0);
  assert.equal(await K.purgeOld(undefined, now), 0);
  assert.equal((await K.totalKept()).meetings, 2);
  assert.equal(await K.purgeOld(14, now), 2);
  assert.equal((await K.listSegs('old')).length, 0);
  assert.equal((await K.listSegs('new')).length, 1);
  assert.equal(await K.purgeOld(1, now), 1);
  assert.equal((await K.totalKept()).meetings, 0);
});

await test('pcm16kFrom: null without the audio APIs; joins decoded and resampled parts when they exist', async () => {
  assert.equal(await K.pcm16kFrom([{ blob: blob(10) }], { AudioContextCtor: undefined, OfflineCtor: undefined }), null);
  assert.equal(await K.pcm16kFrom([], {}), null);
  const rates = [];
  class Ctx {
    async decodeAudioData() {
      return { duration: 0.5 };
    }
    close() {
      return Promise.resolve();
    }
  }
  class Off {
    constructor(ch, len, sr) {
      rates.push([ch, len, sr]);
      this.len = len;
      this.destination = {};
    }
    createBufferSource() {
      return { connect() {}, start() {} };
    }
    async startRendering() {
      return { getChannelData: () => new Float32Array(this.len).fill(0.25) };
    }
  }
  const pcm = await K.pcm16kFrom([{ blob: blob(5) }, blob(5)], { AudioContextCtor: Ctx, OfflineCtor: Off });
  assert.equal(pcm.length, 16000);
  assert.deepEqual(rates, [[1, 8000, 16000], [1, 8000, 16000]]);
  assert.equal(pcm[0], 0.25);
  class Bad extends Ctx {
    async decodeAudioData() {
      throw new Error('bad data');
    }
  }
  assert.equal(await K.pcm16kFrom([blob(5)], { AudioContextCtor: Bad, OfflineCtor: Off }), null);
});

// ---- the keeper with a fake MediaRecorder and clock ----
const recorders = [];
class FakeRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.state = 'inactive';
    recorders.push(this);
  }
  static isTypeSupported() {
    return true;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: blob(1000) });
      this.onstop?.();
    });
  }
}
globalThis.MediaRecorder = FakeRecorder;

const manual = () => {
  const t = { ms: 1_000_000, fns: [] };
  return {
    t,
    now: () => t.ms,
    setTimer: (fn) => (t.fns.push(fn), t.fns.length),
    clearTimer: () => {},
    advance(sec) {
      t.ms += sec * 1000;
    },
    fire: () => t.fns.forEach((f) => f()),
  };
};

await test('keeper: restarts every segment so each blob is complete, with times from the start', async () => {
  recorders.length = 0;
  const c = manual();
  const put = [];
  const k = await K.startKeeping({ stream: {}, meetingId: 'k1', put: async (s) => put.push(s), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  assert.equal(recorders.length, 1);
  assert.deepEqual(recorders[0].opts, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
  c.advance(30);
  c.fire();
  assert.equal(recorders.length, 2); // the next one is running before the old one is stopped
  c.advance(30);
  c.fire();
  c.advance(12);
  await k.stop();
  assert.deepEqual(put.map((s) => [s.seq, s.t0, s.dur]), [[0, 0, 30], [1, 30, 30], [2, 60, 12]]);
  assert.ok(put.every((s) => s.blob.size === 1000 && s.meetingId === 'k1'));
});

await test('keeper: a paused stretch keeps nothing (the recorder is stopped), the next segment starts at the resume', async () => {
  recorders.length = 0;
  const c = manual();
  const put = [];
  const k = await K.startKeeping({ stream: {}, meetingId: 'k2', put: async (s) => put.push(s), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  c.advance(10);
  k.setPaused(true);
  c.advance(30);
  c.fire(); // the timer must not start a recorder while paused
  assert.equal(recorders.length, 1);
  c.advance(30);
  k.setPaused(false);
  assert.equal(recorders.length, 2);
  c.advance(5);
  await k.stop();
  assert.deepEqual(put.map((s) => [s.seq, s.t0, s.dur]), [[0, 0, 10], [1, 70, 5]]);
});

await test('keeper: a failed write stops keeping, reports once, and never throws', async () => {
  recorders.length = 0;
  const c = manual();
  const errs = [];
  let calls = 0;
  const k = await K.startKeeping({ stream: {}, meetingId: 'k3', put: async () => (calls++, Promise.reject(new Error('QuotaExceededError'))), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onError: (e) => errs.push(e.message) });
  c.advance(30);
  c.fire();
  await new Promise((r) => setTimeout(r, 10));
  c.advance(30);
  c.fire();
  k.setPaused(true);
  k.setPaused(false);
  await k.stop();
  assert.equal(errs.length, 1);
  assert.equal(calls, 1);
  assert.equal(k.failed, true);
});

await test('keeper: a second take of the same meeting continues the numbering instead of overwriting', async () => {
  await K.putSeg(seg('k4', 0, 0, 30));
  await K.putSeg(seg('k4', 1, 30, 30));
  const c = manual();
  const k = await K.startKeeping({ stream: {}, meetingId: 'k4', now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  c.advance(7);
  await k.stop();
  assert.deepEqual((await K.listSegs('k4', { allTakes: true })).map((s) => s.seq), [0, 1, 2]);
  assert.deepEqual((await K.listSegs('k4')).map((s) => [s.seq, s.take]), [[2, 1]], 'readers see the latest take only');
});

await test('a meeting id recorded twice: segAt, segRange, listSegs and keptInfo use the latest take only (unless asked for all)', async () => {
  // take 1 (saved before takes existed: no field) and a second recording whose t0 starts at 0 again
  await K.putSeg(seg('tk', 0, 0, 30, 100));
  await K.putSeg(seg('tk', 1, 30, 30, 100));
  const c = manual();
  const k = await K.startKeeping({ stream: {}, meetingId: 'tk', now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  c.advance(20);
  await k.stop();
  assert.deepEqual((await K.listSegs('tk')).map((s) => [s.seq, s.t0, s.take]), [[2, 0, 1]]);
  assert.equal((await K.segAt('tk', 10)).seq, 2, 'not the old take that also covers second 10');
  assert.equal(await K.segAt('tk', 45), null, 'the old take reached 60 s, the new one only 20');
  assert.deepEqual((await K.segRange('tk', 0, 100)).map((s) => s.seq), [2]);
  assert.deepEqual((await K.segRange('tk', 0, 100, { allTakes: true })).map((s) => s.seq), [0, 1, 2]);
  assert.equal((await K.keptInfo('tk')).segs, 1);
});

await test('layoutOnTimeline: a segment sits at its own second, a pause stays silent, the length is the range asked for', () => {
  const ones = (n, v = 1) => new Float32Array(n).fill(v);
  const SR = 10; // a small rate keeps the arrays readable
  // segments at 0-3 s and 8-10 s (a pause between), range 0..10
  const out = K.layoutOnTimeline([{ t0: 0, pcm: ones(30) }, { t0: 8, pcm: ones(20, 2) }], 0, 10, SR);
  assert.equal(out.length, 100);
  assert.deepEqual([out[0], out[29], out[30], out[79], out[80], out[99]], [1, 1, 0, 0, 2, 2]);
  // a range that starts inside the first segment: times shift by `from`, the tail is not cut
  const mid = K.layoutOnTimeline([{ t0: 0, pcm: ones(30) }, { t0: 8, pcm: ones(20, 2) }], 2, 10, SR);
  assert.equal(mid.length, 80);
  assert.deepEqual([mid[9], mid[10], mid[59], mid[60], mid[79]], [1, 0, 0, 2, 2]);
  // overlapping rotation edges: the later segment wins in the overlap, nothing is lost or doubled in length
  const seam = K.layoutOnTimeline([{ t0: 0, pcm: ones(32, 1) }, { t0: 3, pcm: ones(30, 3) }], 0, 6, SR);
  assert.equal(seam.length, 60);
  assert.deepEqual([seam[29], seam[30], seam[59]], [1, 3, 3]);
  // segments past the range are cut at it; an empty list is silence
  assert.equal(K.layoutOnTimeline([{ t0: 5, pcm: ones(100) }], 0, 8, SR).length, 80);
  assert.ok(K.layoutOnTimeline([], 0, 2, SR).every((x) => x === 0));
});

await test('pcm16kRange: decoded segments are placed by their t0, so a pause does not shift the later words', async () => {
  const decoded = { a: new Float32Array(16000 * 2).fill(1), b: new Float32Array(16000 * 2).fill(2) };
  class Ctx {
    decodeAudioData(buf) {
      return Promise.resolve({ key: new Uint8Array(buf)[0] === 1 ? 'a' : 'b', duration: 2 });
    }
    close() {
      return Promise.resolve();
    }
  }
  class Off {
    constructor() {
      this.destination = {};
    }
    createBufferSource() {
      const o = this;
      return { connect() {}, start() {}, set buffer(b) { o.key = b.key; } };
    }
    startRendering() {
      return Promise.resolve({ getChannelData: () => decoded[this.key] });
    }
  }
  const mk = (v, t0) => ({ t0, dur: 2, blob: { arrayBuffer: async () => new Uint8Array([v]).buffer } });
  const pcm = await K.pcm16kRange([mk(1, 0), mk(2, 10)], 0, 12, { AudioContextCtor: Ctx, OfflineCtor: Off });
  assert.equal(pcm.length, 16000 * 12);
  assert.equal(pcm[16000 * 1], 1);
  assert.equal(pcm[16000 * 5], 0, 'the pause is silence');
  assert.equal(pcm[16000 * 10 + 5], 2, 'the later segment is at its own second');
  assert.equal(pcm[16000 * 12 - 1], 2, 'the tail is not cut');
});

await test('keeper: resuming from a pause on a dead stream reports once through onError and keeping stops cleanly', async () => {
  recorders.length = 0;
  const c = manual();
  const errs = [];
  const put = [];
  const k = await K.startKeeping({ stream: {}, meetingId: 'k5', put: async (s) => put.push(s), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onError: (e) => errs.push(e.message) });
  c.advance(5);
  k.setPaused(true);
  const Real = globalThis.MediaRecorder;
  globalThis.MediaRecorder = undefined;
  // the keeper took Recorder at start, so make the same class refuse to start instead
  const realStart = FakeRecorder.prototype.start;
  FakeRecorder.prototype.start = () => {
    throw new Error('InvalidStateError');
  };
  try {
    assert.doesNotThrow(() => k.setPaused(false));
    assert.doesNotThrow(() => k.rotate());
    assert.doesNotThrow(() => k.setPaused(true));
  } finally {
    FakeRecorder.prototype.start = realStart;
    globalThis.MediaRecorder = Real;
  }
  assert.deepEqual(errs, ['InvalidStateError']);
  assert.equal(k.failed, true);
  await k.stop();
});

await test('keeper: a rotation that cannot start a recorder ends the old one, reports once and stops the interval', async () => {
  recorders.length = 0;
  const c = manual();
  const errs = [];
  let cleared = 0;
  const put = [];
  const k = await K.startKeeping({ stream: {}, meetingId: 'k6', put: async (s) => put.push(s), now: c.now, setTimer: c.setTimer, clearTimer: () => cleared++, onError: (e) => errs.push(e.message) });
  c.advance(30);
  const realStart = FakeRecorder.prototype.start;
  FakeRecorder.prototype.start = () => {
    throw new Error('dead stream');
  };
  try {
    assert.doesNotThrow(() => c.fire());
    assert.doesNotThrow(() => c.fire());
  } finally {
    FakeRecorder.prototype.start = realStart;
  }
  await k.stop();
  assert.deepEqual(errs, ['dead stream']);
  assert.ok(cleared >= 1);
  assert.deepEqual(put.map((s) => [s.seq, s.dur]), [[0, 30]], 'what was recorded before the failure is still saved');
});

// ---- the offscreen document with keepAudio ----
let sent = [];
let onMessage = null;
globalThis.chrome = {
  runtime: { onMessage: { addListener: (f) => (onMessage = f) }, sendMessage: (m) => (sent.push(m), Promise.resolve({ ok: true })), getURL: (p) => p },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
};
let nodes = [];
let gains = [];
let dests = 0;
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
  constructor(opts) {
    this.opts = opts;
    this.state = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource(s) {
    return { s, connect: (n) => n };
  }
  createGain() {
    const g = { gain: { value: 1 }, connect: (x) => x };
    if (!this.opts) gains.push(g); // only the playback context's gains: the ones the kept recording uses
    return g;
  }
  createMediaStreamDestination() {
    dests++;
    return { stream: { kept: true } };
  }
  close() {
    return Promise.resolve();
  }
};
const stream = () => ({ getAudioTracks: () => [{ addEventListener() {}, readyState: 'live', muted: false, enabled: true }], getTracks: () => [{ stop() {} }] });
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => stream() } }, configurable: true });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const b64 = body.contents[0].parts.find((p) => p.inlineData).inlineData.data;
  const sec = (Buffer.from(b64, 'base64').length - 44) / 32000;
  return Response.json({ candidates: [{ content: { parts: [{ text: sec > 0 ? Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') : '' }] } }], usageMetadata: {} });
};

// timers and the clock are taken over while a recording runs, so 30 s can pass in no time
const realInterval = globalThis.setInterval;
const realClear = globalThis.clearInterval;
const realNow = Date.now;
let timers = [];
let fakeNow = realNow();
const takeOverClock = () => {
  timers = [];
  fakeNow = realNow();
  Date.now = () => fakeNow;
  globalThis.setInterval = (fn, ms) => (timers.push({ fn, ms, on: true }), timers.length);
  globalThis.clearInterval = (id) => {
    if (timers[id - 1]) timers[id - 1].on = false;
  };
};
const giveBackClock = () => {
  Date.now = realNow;
  globalThis.setInterval = realInterval;
  globalThis.clearInterval = realClear;
};
const fireSegTimer = () => timers.filter((t) => t.ms === K.SEG_MS && t.on).forEach((t) => t.fn());

await import('../src/offscreen.js');
const rpc = (msg) => new Promise((resolve) => onMessage({ target: 'offscreen', ...msg }, {}, resolve));
const feed = (node, sec, amp) => {
  for (let n = 0; n < (sec * SR) / 2048; n++) {
    const b = new Float32Array(2048);
    if (amp) for (let i = 0; i < 2048; i++) b[i] = amp * Math.sin((2 * Math.PI * 220 * (n * 2048 + i)) / SR);
    node.port.onmessage({ data: b });
  }
};
const base = { ...DEFAULTS, sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'gemini-3.8-flash', geminiModel: 'gemini-3.8-flash', captureMic: false };

async function recordWith(settings, meetingId, play) {
  sent = [];
  nodes = [];
  gains = [];
  dests = 0;
  recorders.length = 0;
  takeOverClock();
  try {
    const r = await rpc({ type: 'start', streamId: 's', settings, meetingId });
    assert.equal(r.ok, true, JSON.stringify(r));
    try {
      await play(nodes[0]);
    } finally {
      await rpc({ type: 'stop' });
    }
  } finally {
    giveBackClock();
  }
  return { segments: sent.filter((m) => m.type === 'segment'), dbg: sent.filter((m) => m.type === 'dbg').map((m) => m.note) };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

await test('keepAudio off (the default): no MediaRecorder, no second graph', async () => {
  const r = await recordWith(base, 'o1', async (n) => feed(n, 20, 0.1));
  assert.equal(recorders.length, 0);
  assert.equal(dests, 0);
  assert.equal(r.segments.length, 1);
  assert.equal((await K.listSegs('o1')).length, 0);
});

await test('keepAudio on: segments restart every 30 s and are stored for the meeting', async () => {
  const r = await recordWith({ ...base, keepAudio: true }, 'o2', async (n) => {
    feed(n, 5, 0.1);
    fakeNow += 30000;
    fireSegTimer();
    await tick();
    fakeNow += 30000;
    fireSegTimer();
    await tick();
    fakeNow += 8000;
  });
  assert.equal(dests, 1);
  assert.deepEqual(recorders[0].opts, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
  const list = await K.listSegs('o2');
  assert.deepEqual(list.map((s) => [s.seq, s.t0, s.dur]), [[0, 0, 30], [1, 30, 30], [2, 60, 8]]);
  assert.ok(r.segments.length >= 1); // transcription went on as usual
});

await test('keepAudio on, paused: gains drop to 0 and nothing is kept from the paused stretch; the mic gain follows the mic switch', async () => {
  await recordWith({ ...base, keepAudio: true, captureMic: true }, 'o3', async (n) => {
    feed(n, 3, 0.1);
    const [tabGain, micGain] = gains;
    assert.ok(tabGain.gain.value > 0 && micGain.gain.value > 0);
    await rpc({ type: 'mic', on: false });
    assert.equal(micGain.gain.value, 0);
    await rpc({ type: 'mic', on: true });
    assert.ok(micGain.gain.value > 0);
    fakeNow += 10000;
    await rpc({ type: 'pause', on: true });
    assert.equal(tabGain.gain.value, 0);
    assert.equal(micGain.gain.value, 0);
    fakeNow += 40000;
    fireSegTimer(); // no recorder while paused
    await tick();
    fakeNow += 20000;
    await rpc({ type: 'pause', on: false });
    assert.ok(tabGain.gain.value > 0 && micGain.gain.value > 0);
    fakeNow += 6000;
  });
  const list = await K.listSegs('o3');
  assert.deepEqual(list.map((s) => [s.seq, s.t0, s.dur]), [[0, 0, 10], [1, 70, 6]]);
});

await test('keepAudio on, quota error: keeping stops with one note, transcription is not affected', async () => {
  const proto = globalThis.IDBObjectStore.prototype;
  const realPut = proto.put;
  const r = await (async () => {
    try {
      proto.put = function () {
        throw new DOMException('quota', 'QuotaExceededError');
      };
      return await recordWith({ ...base, keepAudio: true }, 'o4', async (n) => {
        feed(n, 20, 0.1);
        fakeNow += 30000;
        fireSegTimer();
        await tick();
        fakeNow += 30000;
        fireSegTimer();
        await tick();
      });
    } finally {
      proto.put = realPut;
    }
  })();
  assert.equal(r.dbg.filter((d) => /kept recording stopped/.test(d)).length, 1, r.dbg.join('\n'));
  assert.equal(r.segments.length, 1);
  assert.equal((await K.listSegs('o4')).length, 0);
});

await test('keepAudio on without MediaRecorder: one note, recording and transcription carry on', async () => {
  const real = globalThis.MediaRecorder;
  delete globalThis.MediaRecorder;
  try {
    const r = await recordWith({ ...base, keepAudio: true }, 'o5', async (n) => feed(n, 20, 0.1));
    assert.ok(r.dbg.some((d) => /keep recording: could not start/.test(d)));
    assert.equal(r.segments.length, 1);
  } finally {
    globalThis.MediaRecorder = real;
  }
});

await test('purgeOld(keepAudioDays) runs at the start of a recording', async () => {
  const DAY = 86400000;
  await K.putSeg(seg('stale', 0, 0, 30, 10, realNow() - 20 * DAY));
  await recordWith({ ...base, keepAudioDays: 14 }, 'o6', async (n) => feed(n, 3, 0.1));
  await tick();
  assert.equal((await K.listSegs('stale')).length, 0);
  await K.putSeg(seg('stale2', 0, 0, 30, 10, realNow() - 20 * DAY));
  await recordWith({ ...base, keepAudioDays: 0 }, 'o7', async (n) => feed(n, 3, 0.1));
  await tick();
  assert.equal((await K.listSegs('stale2')).length, 1);
});

console.log(`\n${passed} passed`);
