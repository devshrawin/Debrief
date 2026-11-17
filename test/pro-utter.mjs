// Timed utterances: what each provider returns (fake fetch only, no live service was called), turning them into segments
// with real times and a me/others call per utterance.
import assert from 'node:assert/strict';
import { transcribe, transcribeDetailed, _resetVerbose } from '../src/stt.js';
import { segmentsFromUtterances } from '../src/utter.js';
import { timelineOf, BLOCK_SEC } from '../src/mixer.js';
import { transcribePiece, readInParts } from '../src/coverage.js';
import { chunkSecs, SR } from '../src/chunker.js';
import { quotaCheck } from '../src/usage.js';
import { encodeWav } from '../src/wav.js';
import { DEFAULTS } from '../src/store.js';

let passed = 0;
const test = async (name, fn) => {
  try {
    _resetVerbose();
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
};

const wav = encodeWav(new Float32Array(SR * 20), SR); // 20 s
let calls = [];
let handler = () => new Response('{}', { status: 500 });
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body });
  return handler(String(url), init);
};
const dg = { ...DEFAULTS, sttProvider: 'deepgram', deepgramKey: 'k', deepgramModel: 'nova-3' };
const oa = { ...DEFAULTS, sttProvider: 'openai', sttBase: 'http://localhost:9000/v1', sttModel: 'whisper-1', sttKey: '' };
const formats = () => calls.map((c) => c.body.get('response_format'));

await test('deepgram: utterances and speakers are asked for and read, text stays the transcript', async () => {
  calls = [];
  handler = () => Response.json({ results: { channels: [{ alternatives: [{ transcript: 'Hello there. Hi back.' }] }], utterances: [{ start: 0.5, end: 2, transcript: 'Hello there.', speaker: 0 }, { start: 2.4, end: 4, transcript: 'Hi back.', speaker: 1 }] } });
  const r = await transcribeDetailed(wav, dg);
  assert.equal(r.text, 'Hello there. Hi back.');
  assert.deepEqual(r.utterances, [{ t0: 0.5, t1: 2, text: 'Hello there.', spk: 0 }, { t0: 2.4, t1: 4, text: 'Hi back.', spk: 1 }]);
  assert.match(calls[0].url, /utterances=true/);
  assert.match(calls[0].url, /diarize=true/);
  assert.equal(await transcribe(wav, dg), 'Hello there. Hi back.');
});

await test('deepgram: no utterances in the answer means null', async () => {
  handler = () => Response.json({ results: { channels: [{ alternatives: [{ transcript: 'Just text.' }] }] } });
  assert.deepEqual(await transcribeDetailed(wav, dg), { text: 'Just text.', utterances: null });
});

await test('deepgram: a 400 about diarize is retried without the options and still returns the text', async () => {
  calls = [];
  handler = (url) => (/diarize/.test(url) ? new Response('{"err_msg":"diarize is not supported for this model"}', { status: 400 }) : Response.json({ results: { channels: [{ alternatives: [{ transcript: 'Saved.' }] }] } }));
  const r = await transcribeDetailed(wav, dg);
  assert.equal(r.text, 'Saved.');
  assert.equal(r.utterances, null);
  assert.equal(calls.length, 2);
  assert.ok(!/diarize|utterances/.test(calls[1].url));
});

await test('openai-compatible: verbose_json gives segments as utterances', async () => {
  calls = [];
  handler = () => Response.json({ text: 'One two. Three four.', segments: [{ start: 0, end: 3, text: ' One two.' }, { start: 3.2, end: 6, text: ' Three four.' }] });
  const r = await transcribeDetailed(wav, oa);
  assert.equal(r.text, 'One two. Three four.');
  assert.deepEqual(r.utterances, [{ t0: 0, t1: 3, text: 'One two.' }, { t0: 3.2, t1: 6, text: 'Three four.' }]);
  assert.deepEqual(formats(), ['verbose_json']);
});

await test('openai-compatible: a server that rejects verbose_json is asked for json, and remembered per base URL', async () => {
  calls = [];
  handler = (url, init) => (init.body.get('response_format') === 'verbose_json' ? new Response('{"error":"bad response_format"}', { status: 400 }) : Response.json({ text: 'Plain answer.' }));
  const r = await transcribeDetailed(wav, oa);
  assert.deepEqual(r, { text: 'Plain answer.', utterances: null });
  assert.deepEqual(formats(), ['verbose_json', 'json']);
  calls = [];
  await transcribe(wav, oa);
  assert.deepEqual(formats(), ['json'], 'second call goes straight to json');
  calls = [];
  await transcribe(wav, { ...oa, sttBase: 'http://other:1/v1' });
  assert.equal(formats()[0], 'verbose_json', 'another server is tried afresh');
});

await test('openai-compatible: an answer without text falls back to json too; a {text} only answer has no utterances', async () => {
  calls = [];
  handler = (url, init) => (init.body.get('response_format') === 'verbose_json' ? Response.json({ segments: [] }) : Response.json({ text: 'Back.' }));
  assert.equal(await transcribe(wav, oa), 'Back.');
  assert.deepEqual(formats(), ['verbose_json', 'json']);
  _resetVerbose();
  handler = () => Response.json({ text: 'Only text.' });
  assert.deepEqual(await transcribeDetailed(wav, oa), { text: 'Only text.', utterances: null });
});

await test('openai-compatible: a 500 is not taken for "verbose unsupported"', async () => {
  calls = [];
  handler = () => new Response('{"error":"boom"}', { status: 401 });
  await assert.rejects(transcribeDetailed(wav, oa), /HTTP 401/);
  assert.deepEqual(formats(), ['verbose_json']);
});

await test('sarvam and gemini: no utterances, and transcribe gives the same text as before', async () => {
  handler = () => Response.json({ transcript: 'Namaste everyone.' });
  const sv = { ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'k' };
  assert.deepEqual(await transcribeDetailed(wav, sv), { text: 'Namaste everyone.', utterances: null });
  assert.equal(await transcribe(wav, sv), 'Namaste everyone.');
  handler = () => Response.json({ candidates: [{ content: { parts: [{ text: 'Good morning team.' }] } }], usageMetadata: {} });
  const gm = { ...DEFAULTS, sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'gemini-3.8-flash', geminiModel: 'gemini-3.8-flash' };
  assert.deepEqual(await transcribeDetailed(wav, gm), { text: 'Good morning team.', utterances: null });
  assert.equal(await transcribe(wav, gm), 'Good morning team.');
});

await test('cleaning per utterance: timestamps stripped, empty and loop noise dropped, times clamped and sorted', async () => {
  handler = () => Response.json({ text: 'Later. Early.', segments: [{ start: 15, end: 99, text: 'Later.' }, { start: 3, end: 1, text: 'Early.' }, { start: 5, end: 6, text: '   ' }, { start: 7, end: 8, text: 'la la la la la la la la la la la la la la la la la la la la la la la la' }, { start: -2, end: 2, text: '00:04 Start.\n00:06 More.\n00:08 Again.' }] });
  const r = await transcribeDetailed(wav, oa);
  assert.deepEqual(r.utterances.map((u) => [u.t0, u.t1, u.text]), [[0, 2, 'Start. More. Again.'], [3, 3, 'Early.'], [15, 20, 'Later.']]);
});

await test('empty cleaned text means null utterances', async () => {
  handler = () => Response.json({ text: '', segments: [{ start: 0, end: 1, text: 'x' }] });
  assert.deepEqual(await transcribeDetailed(wav, oa), { text: '', utterances: null });
});

// ---- segmentsFromUtterances ----
const tlOf = (n, fn) => timelineOf(Array.from({ length: n }, (_, i) => fn(i * BLOCK_SEC)));

await test('absolute times, the piece src, and the u flag', () => {
  const segs = segmentsFromUtterances([{ t0: 1, t1: 3, text: 'a' }, { t0: 10, t1: 12, text: 'b' }], { t: 100, src: 'others' });
  assert.deepEqual(segs, [{ t: 101, src: 'others', text: 'a', u: 1 }, { t: 110, src: 'others', text: 'b', u: 1 }]);
});

await test('mixed stream: me/others per utterance from its own window, split lands at the real boundary', () => {
  // mic loud for 0-10 s, tab loud for 10-20 s. Proportional guessing would split 2 + 1 sentences by length instead.
  const tl = tlOf(160, (s) => (s < 10 ? { tab: 0.0, mic: 0.1 } : { tab: 0.1, mic: 0.0 }));
  const utts = [{ t0: 0.5, t1: 4, text: 'Mine one.' }, { t0: 5, t1: 9.5, text: 'Mine two.' }, { t0: 10.6, t1: 19, text: 'This is a very long sentence from the others that would pull a proportional split past ten seconds.' }];
  const segs = segmentsFromUtterances(utts, { t: 60, src: 'mix', timeline: tl });
  assert.deepEqual(segs.map((s) => [s.t, s.src]), [[60.5, 'me'], [70.6, 'others']]);
  assert.equal(segs[0].text, 'Mine one. Mine two.');
});

await test('an utterance with nothing voiced takes the side of the one before', () => {
  const tl = tlOf(160, (s) => (s < 4 ? { tab: 0, mic: 0.1 } : { tab: 0, mic: 0 }));
  const segs = segmentsFromUtterances([{ t0: 0, t1: 3, text: 'Said.' }, { t0: 6, t1: 8, text: 'Quiet.' }], { t: 0, src: 'mix', timeline: tl });
  assert.deepEqual(segs.map((s) => s.src), ['me', 'me']);
});

await test('merging: same src and speaker under 1.2 s apart, never across a src or speaker change', () => {
  const u = (t0, t1, text, spk) => ({ t0, t1, text, spk });
  const segs = segmentsFromUtterances([u(0, 2, 'a', 0), u(2.5, 4, 'b', 0), u(4.5, 6, 'c', 1), u(6.2, 7, 'd', 1), u(9, 10, 'e', 1)], { t: 0, src: 'others' });
  assert.deepEqual(segs.map((s) => [s.t, s.text, s.spk]), [[0, 'a b', 0], [4.5, 'c d', 1], [9, 'e', 1]]);
  const tl = tlOf(80, (s) => (s < 5 ? { tab: 0, mic: 0.1 } : { tab: 0.1, mic: 0 }));
  const sw = segmentsFromUtterances([u(1, 4.9, 'x'), u(5.1, 8, 'y')], { t: 0, src: 'mix', timeline: tl });
  assert.deepEqual(sw.map((s) => s.src), ['me', 'others']);
});

await test('caps: a merged segment stops near 45 s and 700 characters', () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ t0: i * 5, t1: i * 5 + 4.5, text: `Sentence number ${i}.` }));
  const segs = segmentsFromUtterances(long, { t: 0, src: 'others' });
  assert.ok(segs.length >= 2 && segs.every((s) => s.u === 1));
  assert.ok(segs[0].text.split('. ').length <= 10, 'first segment stays within 45 s');
  const wide = Array.from({ length: 10 }, (_, i) => ({ t0: i, t1: i + 0.9, text: 'w'.repeat(100) }));
  const w = segmentsFromUtterances(wide, { t: 0, src: 'others' });
  assert.ok(w.length > 1 && w.every((s) => s.text.length <= 700));
});

// ---- coverage: utterances travel with the text that was kept ----
const tone = (sec, amp = 0.08) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i / 7));
await test('transcribePiece keeps first-read utterances; a re-read in parts offsets each part', async () => {
  const pcm = tone(100);
  const good = { text: 'x'.repeat(2000), utterances: [{ t0: 1, t1: 2, text: 'hi' }] };
  assert.deepEqual((await transcribePiece({ pcm, wav, voicedSec: 100, transcribeFn: async () => good })).utterances, good.utterances);
  let n = 0;
  const fn = async () => (n++ === 0 ? { text: 'Okay.', utterances: [{ t0: 0, t1: 1, text: 'Okay.' }] } : { text: 'p'.repeat(400), utterances: [{ t0: 1, t1: 2, text: 'part' }] });
  const r = await transcribePiece({ pcm, wav, voicedSec: 100, transcribeFn: fn, encode: (x) => x });
  assert.ok(r.text.length > 400 && r.utterances.length >= 2);
  assert.equal(r.utterances[0].t0, 1);
  assert.ok(r.utterances[1].t0 > 40, 'second part is offset by where it starts');
  const plain = await readInParts({ pcm, encode: (x) => x, transcribeFn: async () => 'text' });
  assert.equal(plain.utterances, null);
});

await test('chunkSecs short, and the free-quota estimate follows it', () => {
  const g = { sttProvider: 'gemini', sttGeminiChunk: 'short' };
  assert.deepEqual(chunkSecs(g), { minSec: 30, maxSec: 45 });
  assert.deepEqual(chunkSecs({ ...g, sttGeminiChunk: 'standard' }), { minSec: 100, maxSec: 150 });
  assert.deepEqual(chunkSecs({ ...g, sttGeminiChunk: 'long' }), { minSec: 200, maxSec: 240 });
  const s = { ...g, sttGeminiModel: 'm' };
  const std = quotaCheck({}, { m: 1000 }, { ...s, sttGeminiChunk: 'standard' }).need;
  const sh = quotaCheck({}, { m: 1000 }, s);
  assert.equal(sh.need, 110); // 3600 / 33: pieces are cut at the first pause after 30 s, so they run near 33 s, not 37.5
  assert.ok(sh.need / std > 3 && sh.need / std < 4);
  assert.equal(sh.longHelps, true);
});

await test('openai-compatible: one transient 400 does not switch verbose_json off; a plain retry that fails is not remembered either', async () => {
  calls = [];
  let n = 0;
  handler = (url, init) => {
    if (init.body.get('response_format') === 'verbose_json') return n++ === 0 ? new Response('{"error":"overloaded, try later"}', { status: 400 }) : Response.json({ text: 'Back.', segments: [{ start: 0, end: 1, text: 'Back.' }] });
    return Response.json({ text: 'Plain.' });
  };
  assert.equal(await transcribe(wav, oa), 'Plain.');
  const r = await transcribeDetailed(wav, oa);
  assert.equal(r.utterances?.length, 1, 'verbose_json is tried again after a transient 400');
  handler = (url, init) => (init.body.get('response_format') === 'verbose_json' ? new Response('{"error":"bad response_format"}', { status: 400 }) : new Response('{"error":"down"}', { status: 400 }));
  await assert.rejects(transcribe(wav, { ...oa, sttBase: 'http://other:1/v1' }));
  calls = [];
  handler = () => Response.json({ text: 'ok', segments: [] });
  await transcribe(wav, { ...oa, sttBase: 'http://other:1/v1' });
  assert.equal(formats()[0], 'verbose_json', 'the plain retry failed, so nothing was remembered');
});

await test('openai-compatible: the "no verbose_json" memo expires after 30 minutes and a 415/422 counts', async () => {
  calls = [];
  const realNow = Date.now;
  handler = (url, init) => (init.body.get('response_format') === 'verbose_json' ? new Response('nope', { status: 422 }) : Response.json({ text: 'Plain.' }));
  const s = { ...oa, sttBase: 'http://memo:1/v1' };
  try {
    await transcribe(wav, s);
    calls = [];
    await transcribe(wav, s);
    assert.deepEqual(formats(), ['json'], 'remembered');
    Date.now = () => realNow() + 31 * 60 * 1000;
    calls = [];
    await transcribe(wav, s);
    assert.equal(formats()[0], 'verbose_json', 'forgotten after 30 minutes');
  } finally {
    Date.now = realNow;
  }
});

const SPEECH = ["Let's check the numbers for Q3.", 'Rules: no phones in the room.', 'The user wants a faster export.', 'Wait, the budget is approved?', 'चलो Q3 के numbers check करते हैं. Let us check the numbers for Q3.', 'Wait, budget approve हो गया क्या?'];

await test('deepgram and whisper utterances keep ordinary speech that looks like a reasoning opener', async () => {
  handler = () => Response.json({ results: { channels: [{ alternatives: [{ transcript: SPEECH.join(' ') }] }], utterances: SPEECH.map((t, i) => ({ start: i * 3, end: i * 3 + 2, transcript: t, speaker: 0 })) } });
  const d = await transcribeDetailed(wav, dg);
  assert.deepEqual(d.utterances.map((u) => u.text), SPEECH);
  handler = () => Response.json({ text: SPEECH.join(' '), segments: SPEECH.map((t, i) => ({ start: i * 3, end: i * 3 + 2, text: t })) });
  const w = await transcribeDetailed(wav, oa);
  assert.deepEqual(w.utterances.map((u) => u.text), SPEECH);
});

console.log(`\n${passed} passed`);
