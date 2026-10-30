// English written in Malayalam letters by the dedicated transcription model: in a meeting that mixes English in, a general model reads
// the piece once and its answer is used when it has the English words in English letters. Costs are capped, and other cases are untouched.
import assert from 'node:assert/strict';
import { transcribe, resetSttBudget } from '../src/stt.js';
import { encodeWav } from '../src/wav.js';
import { SR } from '../src/chunker.js';
import { DEFAULTS } from '../src/store.js';

let passed = 0;
const test = async (name, fn) => {
  try {
    resetSttBudget();
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
};

// distinct words, so the speech layer does not take the text for a loop of one phrase and drop it as noise
const syl = ['ക', 'ത', 'മ', 'ര', 'ല', 'ന', 'സ', 'ട', 'പ', 'വ', 'ദ', 'ഗ'];
const mlWord = (i) => syl[i % 12] + syl[Math.floor(i / 12) % 12] + syl[Math.floor(i / 144) % 12] + 'ം';
const TRANSLIT = Array.from({ length: 240 }, (_, i) => mlWord(i)).join(' ');
const MIXED = Array.from({ length: 120 }, (_, i) => `${mlWord(i)} point${i}`).join(' ');
const wav = encodeWav(new Float32Array(SR), SR);

let urls = [];
let answers = {};
globalThis.fetch = async (url) => {
  urls.push(String(url));
  const model = decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]);
  const text = answers[model];
  if (text === undefined) return new Response('{"error":{"message":"no such model in this test"}}', { status: 404 });
  return Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
};
const settings = (extra = {}) => ({ ...DEFAULTS, geminiKey: 'k', sttGeminiModel: 'gemini-3.5-transcribe', geminiModel: 'gemini-3.8-flash', meetingLanguages: ['ml', 'en'], ...extra });
const models = () => urls.map((u) => decodeURIComponent(u.match(/models\/([^:]+):/)[1]));

await test('Malayalam letters only, in a Malayalam + English meeting: the general model\'s answer with English letters is used', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT, 'gemini-3.8-flash': MIXED };
  const out = await transcribe(wav, settings());
  assert.match(out, /point119/);
  assert.deepEqual(models(), ['gemini-3.5-transcribe', 'gemini-3.8-flash']);
});

await test('the general model does not do better: the dedicated answer stays', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT, 'gemini-3.8-flash': TRANSLIT };
  assert.equal(await transcribe(wav, settings()), TRANSLIT.trim());
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT, 'gemini-3.8-flash': 'Okay.' };
  assert.equal(await transcribe(wav, settings()), TRANSLIT.trim(), 'a much shorter answer is not taken for a better one');
});

await test('the general model failing keeps the dedicated answer', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT }; // every other model answers 404
  assert.equal(await transcribe(wav, settings()), TRANSLIT.trim());
});

await test('text that already has English in it, or a short answer, is not checked (no extra request)', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': MIXED, 'gemini-3.8-flash': 'never asked' };
  assert.equal(await transcribe(wav, settings()), MIXED.trim());
  assert.equal(urls.length, 1);
  urls = [];
  answers = { 'gemini-3.5-transcribe': 'ഇത് ഇങ്ങനെ തന്നെ', 'gemini-3.8-flash': 'never asked' };
  await transcribe(wav, settings());
  assert.equal(urls.length, 1);
});

await test('a meeting in Malayalam only (no English chosen) is not checked', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT, 'gemini-3.8-flash': MIXED };
  assert.equal(await transcribe(wav, settings({ meetingLanguages: ['ml'] })), TRANSLIT.trim());
  assert.equal(urls.length, 1);
});

await test('an automatic language setting counts as mixing English in', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT, 'gemini-3.8-flash': MIXED };
  const out = await transcribe(wav, settings({ meetingLanguages: [], meetingLanguage: 'auto' }));
  assert.match(out, /point119/);
});

await test('only a few extra requests are spent in one recording', async () => {
  urls = [];
  answers = { 'gemini-3.5-transcribe': TRANSLIT, 'gemini-3.8-flash': MIXED };
  for (let i = 0; i < 12; i++) await transcribe(wav, settings());
  const general = models().filter((m) => m === 'gemini-3.8-flash').length;
  assert.equal(general, 8);
  assert.equal(models().filter((m) => m === 'gemini-3.5-transcribe').length, 12);
});

await test('a general model chosen as the main one is never checked against itself', async () => {
  urls = [];
  answers = { 'gemini-3.8-flash': TRANSLIT };
  assert.equal(await transcribe(wav, settings({ sttGeminiModel: 'gemini-3.8-flash' })), TRANSLIT.trim());
  assert.equal(urls.length, 1);
});

console.log(`\n${passed} passed`);
