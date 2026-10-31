// Tests for the Pro features: usage tracking, dictionary, minutes pipeline, sharing, attendance, local models.
import assert from 'node:assert/strict';
import { encodeWav } from '../src/wav.js';
import { SR } from '../src/chunker.js';
import { DEFAULTS } from '../src/store.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}

let calls = [];
let responder = () => new Response('{}');
globalThis.fetch = async (url, init = {}) => {
  const req = new Request(url, init);
  calls.push({ url: String(url), req, init });
  return responder(req, calls.length);
};
const wav = encodeWav(new Float32Array(SR * 2), SR); // 2 s of audio

// ---------------- usage ----------------
const U = await import('../src/usage.js');
const captured = [];
U.sink.fn = (e) => captured.push(e);

await test('usage: entries add up per day and model, and the quota day is Pacific', () => {
  const t = new Date('2026-10-13T03:00:00Z'); // still 12 Oct in Pacific time
  let u = U.addEntry({}, { provider: 'gemini', model: 'm1', kind: 'stt', req: 1, audioSec: 100 }, t);
  u = U.addEntry(u, { provider: 'gemini', model: 'm1', kind: 'stt', req: 1, fail: true, rl: true }, t);
  u = U.addEntry(u, { provider: 'gemini', model: 'm1', kind: 'stt', tin: 500, tout: 40 }, t);
  assert.deepEqual(Object.keys(u), ['2026-10-12']);
  const [r] = U.summarize(u, 1, t);
  assert.equal(r.req, 2);
  assert.equal(r.fail, 1);
  assert.equal(r.rl, 1);
  assert.equal(r.tin, 500);
  assert.equal(r.audioSec, 100);
});

await test('usage: summarize spans days, old days are pruned', () => {
  const now = new Date('2026-10-13T20:00:00Z');
  let u = U.addEntry({}, { provider: 'p', model: 'm', kind: 'llm', req: 1 }, new Date('2026-10-11T20:00:00Z'));
  u = U.addEntry(u, { provider: 'p', model: 'm', kind: 'llm', req: 2 }, now);
  assert.equal(U.summarize(u, 1, now)[0].req, 2);
  assert.equal(U.summarize(u, 7, now)[0].req, 3);
  u = U.addEntry(u, { provider: 'p', model: 'm', kind: 'llm', req: 1 }, new Date('2027-01-20T20:00:00Z'));
  assert.equal(Object.keys(u).length, 1);
});

await test('usage: limits are learned from quota errors, typed limits parse, 80% warning', () => {
  assert.deepEqual(U.learnLimit('Quota exceeded for metric: x, limit: 20, model: gemini-3.8-flash Please retry in 18h'), { model: 'gemini-3.8-flash', limit: 20 });
  assert.equal(U.learnLimit('some other error'), null);
  assert.deepEqual(U.parseLimits('gemini-3.8-flash=20\nbad line\nm2: 50'), { 'gemini-3.8-flash': 20, m2: 50 });
  const now = new Date('2026-10-13T20:00:00Z');
  const u = U.addEntry({}, { provider: 'gemini', model: 'gemini-3.8-flash', kind: 'llm', req: 17 }, now);
  assert.deepEqual(U.nearLimit(u, { 'gemini-3.8-flash': 20 }, now), [{ model: 'gemini-3.8-flash', used: 17, limit: 20 }]);
  assert.deepEqual(U.nearLimit(u, { 'gemini-3.8-flash': 100 }, now), []);
});

await test('usage: cost estimate uses the user prices only', () => {
  const rows = [{ model: 'claude-x', tin: 2e6, tout: 1e6 }, { model: 'free', tin: 5e6, tout: 0 }];
  const cost = U.estimateCost(rows, U.parsePrices('claude-x=3,15'));
  assert.equal(cost, 21);
  assert.equal(U.estimateCost(rows, {}), null);
});

await test('usage: Gemini transcription records the request, tokens and audio minutes', async () => {
  captured.length = 0;
  calls = [];
  responder = () => Response.json({ candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 7 } });
  const { transcribe } = await import('../src/stt.js');
  assert.equal(await transcribe(wav, { ...DEFAULTS, geminiKey: 'k' }), 'hello');
  const req = captured.find((e) => e.req === 1);
  assert.equal(req.provider, 'gemini');
  assert.equal(req.model, 'gemini-3.5-transcribe');
  assert.equal(req.kind, 'stt');
  const tok = captured.find((e) => e.tin);
  assert.equal(tok.tin, 120);
  assert.equal(tok.tout, 7);
  assert.ok(Math.abs(tok.audioSec - 2) < 0.01);
});

await test('usage: a 429 is recorded as a limit hit and teaches the limit', async () => {
  captured.length = 0;
  calls = [];
  responder = () => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }), { status: 429 });
  const { geminiFetch } = await import('../src/gemini.js');
  const res = await geminiFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', { method: 'POST', headers: {} }, { geminiKey: 'k' }, { kind: 'llm' });
  assert.equal(res.status, 429);
  await new Promise((r) => setTimeout(r, 20));
  const e = captured.find((x) => x.rl);
  assert.equal(e.kind, 'llm');
  assert.equal(e.model, 'gemini-3.8-flash');
  assert.deepEqual(e.learned, { model: 'gemini-3.8-flash', limit: 20 });
});

await test('usage: a per-minute 429 is not taken for the daily limit', async () => {
  captured.length = 0;
  calls = [];
  responder = () => new Response(JSON.stringify({ error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, model: gemini-3.8-flash, quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier. Please retry in 12s' } }), { status: 429 });
  const { geminiFetch } = await import('../src/gemini.js');
  await geminiFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', { method: 'POST', headers: {} }, { geminiKey: 'k' }, { kind: 'llm' });
  await new Promise((r) => setTimeout(r, 20));
  const e = captured.find((x) => x.rl);
  assert.ok(e, 'the request is still counted as a limit hit');
  assert.equal(e.learned, null);
});

await test('usage: other STT providers record requests and audio minutes', async () => {
  captured.length = 0;
  responder = () => Response.json({ transcript: 'x' });
  const { transcribe } = await import('../src/stt.js');
  await transcribe(wav, { ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'k' });
  assert.equal(captured[0].provider, 'sarvam');
  assert.equal(captured[0].req, 1);
  assert.ok(captured[0].audioSec > 1.9);
});

await test('usage: costs are shown in rupees with Indian digit grouping, and the quota reset is shown in Indian time', async () => {
  const U = await import('../src/usage.js');
  assert.equal(U.rupees(1, 88), '\u20B988.00');
  assert.equal(U.rupees(0, 88), '\u20B90.00');
  assert.equal(U.rupees(2000, 88), '\u20B91,76,000');
  assert.equal(U.rupees(1, ''), '\u20B988.00', 'an empty rate falls back to the default');
  assert.equal(U.rupees(1, 83.5), '\u20B983.50');
  // Pacific midnight in summer (PDT = UTC-7) is 12:30 pm in India; in winter (PST = UTC-8) it is 1:30 pm
  const summer = Date.UTC(2026, 9, 15, 3, 0); // 15 Oct 2026, 03:00 UTC = 20:00 PDT on the 14th
  assert.equal(U.istClock(U.nextQuotaReset(summer), summer), '12:30 pm IST');
  const winter = Date.UTC(2026, 11, 15, 3, 0); // 14 Dec 2026, 19:00 PST
  assert.equal(U.istClock(U.nextQuotaReset(winter), winter), '1:30 pm IST');
  const next = U.nextQuotaReset(summer);
  assert.ok(next > summer && next - summer <= 26 * 3600000);
});

console.log(`\n${passed} passed`);
