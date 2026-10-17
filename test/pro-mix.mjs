// Gemini request budget: one mixed stream (one request per chunk with the mic on), me/others from the levels,
// the chunk-length setting, and the "will a one-hour meeting fit today" maths.
import assert from 'node:assert/strict';
import { Chunker, SR, chunkSecs } from '../src/chunker.js';
import { Mixer, attributeMixed, timelineOf, BLOCK_SEC } from '../src/mixer.js';
import { estimateRequests, quotaCheck, addEntry } from '../src/usage.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok', name); };

const block = (amp) => Float32Array.from({ length: 2048 }, (_, i) => amp * Math.sin(i / 7));
const quiet = () => new Float32Array(2048);

// Feed one stream of `blocks` per side through a Mixer into a Chunker, counting the chunks that would be sent.
function run(settings, plan) {
  const sent = [];
  const chunker = new Chunker('mix', (src, t, pcm, metas) => sent.push({ src, t, secs: pcm.length / SR, metas }), chunkSecs(settings));
  const mixer = new Mixer((b, meta) => chunker.push(b, meta));
  for (const [tab, mic] of plan) {
    mixer.pushTab(tab ? block(tab) : quiet());
    mixer.pushMic(mic ? block(mic) : quiet());
  }
  mixer.drain();
  chunker.flush();
  return sent;
}

// 3 minutes of talk: others for 60 s, me for 40 s, others for 80 s, with a short pause between turns.
const turns = [[0.2, 0, 469], [0, 0, 6], [0, 0.2, 312], [0, 0, 6], [0.2, 0, 625]];
const plan = turns.flatMap(([tab, mic, n]) => Array.from({ length: n }, () => [tab, mic]));

await test('Gemini with the mic on: ONE request per chunk, not two', () => {
  const sent = run({ sttProvider: 'gemini' }, plan);
  const secs = plan.length * BLOCK_SEC;
  assert.ok(secs > 170 && secs < 190);
  assert.equal(sent.length, 2, '180 s of meeting at 100-150 s per chunk is two requests in total');
  assert.ok(sent.every((c) => c.src === 'mix' && c.metas.length === Math.round(c.secs / BLOCK_SEC)));
  assert.ok(sent[0].secs >= 100 && sent[0].secs <= 150.5);
});

await test('the "fewer requests" setting makes chunks about 4 minutes and the default is unchanged', () => {
  assert.deepEqual(chunkSecs({ sttProvider: 'gemini' }), { minSec: 100, maxSec: 150 });
  assert.deepEqual(chunkSecs({ sttProvider: 'gemini', sttGeminiChunk: 'standard' }), { minSec: 100, maxSec: 150 });
  assert.deepEqual(chunkSecs({ sttProvider: 'gemini', sttGeminiChunk: 'long' }), { minSec: 200, maxSec: 240 });
  assert.deepEqual(chunkSecs({ sttProvider: 'sarvam', sttGeminiChunk: 'long' }), { minSec: 18, maxSec: 28 }, 'other providers are not affected');
  assert.equal(run({ sttProvider: 'gemini', sttGeminiChunk: 'long' }, plan).length, 1);
});

await test('me / others come out right on a mixed signal', () => {
  // a single chunk holding the whole 180 s; the text is worded in proportion to the speaking time
  const sent = run({ sttProvider: 'gemini', sttGeminiChunk: 'long' }, plan);
  const tl = timelineOf(sent[0].metas);
  const words = (n, w) => Array.from({ length: n }, () => w).join(' ');
  const text = `${words(60, 'word')}. ${words(40, 'word')}. ${words(80, 'word')}.`;
  const segs = attributeMixed(text, 0, tl);
  assert.deepEqual(segs.map((s) => s.src), ['others', 'me', 'others']);
  assert.ok(Math.abs(segs[1].t - 60) < 3, `my turn starts at about 60 s, got ${segs[1].t}`);
  assert.ok(Math.abs(segs[2].t - 100) < 3, `the call resumes at about 100 s, got ${segs[2].t}`);
});

await test('no mic energy means everything is others; neighbours with one speaker are joined; no levels is safe', () => {
  const tl = { tab: Array(100).fill(0.1), mic: Array(100).fill(0) };
  assert.deepEqual(attributeMixed('One. Two. Three.', 5, tl).map((s) => s.src), ['others']);
  assert.equal(attributeMixed('One. Two. Three.', 5, tl)[0].text, 'One. Two. Three.');
  assert.deepEqual(attributeMixed('Hello there', 3, null), [{ t: 3, src: 'others', text: 'Hello there' }]);
  assert.deepEqual(attributeMixed('', 0, tl), []);
  const echo = { tab: Array(100).fill(0.1), mic: Array(100).fill(0.12) }; // speaker bleed into the mic is not "me"
  assert.equal(attributeMixed('Only the call.', 0, echo)[0].src, 'others');
});

await test('a stalled side does not hold the mix back', () => {
  const out = [];
  const m = new Mixer((b, meta) => out.push(meta), 5);
  for (let i = 0; i < 12; i++) m.pushTab(block(0.1));
  assert.ok(out.length >= 7, 'tab blocks go on with a silent mic once the lag limit passes');
  assert.ok(out.every((x) => x.mic === 0));
});

await test('quota maths: requests for a one-hour meeting against what is left today', () => {
  assert.equal(estimateRequests({ minutes: 60, minSec: 100, maxSec: 150 }), 29);
  assert.equal(estimateRequests({ minutes: 60, minSec: 200, maxSec: 240 }), 17);
  assert.equal(estimateRequests({ minutes: 60, minSec: 18, maxSec: 28, streams: 2 }), 314);
  let usage = {};
  for (let i = 0; i < 20; i++) usage = addEntry(usage, { provider: 'gemini', model: 'gemini-3.5-transcribe', kind: 'stt', req: 1 });
  const limits = { 'gemini-3.5-transcribe': 25 };
  const s = { sttProvider: 'gemini', sttGeminiModel: 'gemini-3.5-transcribe' };
  const q = quotaCheck(usage, limits, s);
  assert.deepEqual([q.need, q.left, q.short, q.longHelps], [29, 5, true, false], '29 needed, 5 left: does not fit, and 4-minute pieces would not fit either');
  assert.equal(quotaCheck({}, limits, s).short, true, 'even a fresh day: 29 > 25');
  assert.equal(quotaCheck({}, { 'gemini-3.5-transcribe': 40 }, s).short, false);
  const half = quotaCheck(addEntry({}, { provider: 'gemini', model: 'gemini-3.5-transcribe', kind: 'stt', req: 15 }), { 'gemini-3.5-transcribe': 40 }, s);
  assert.deepEqual([half.short, half.longHelps], [true, true], '25 left: 29 does not fit but 17 does');
  assert.equal(quotaCheck(usage, limits, { ...s, sttGeminiChunk: 'long' }).need, 17);
  assert.equal(quotaCheck(usage, limits, { ...s, sttProvider: 'sarvam' }), null, 'only Gemini has the tight limit');
  assert.equal(quotaCheck(usage, {}, s), null, 'unknown limit: nothing to compare with');
});

console.log(`\n${passed} passed`);
