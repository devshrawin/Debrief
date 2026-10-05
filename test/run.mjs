// Node harness: exercises chunking, WAV encoding, prompts, and every STT/LLM provider against a mocked fetch.
import assert from 'node:assert/strict';
import { Chunker, SR } from '../src/chunker.js';
import { encodeWav } from '../src/wav.js';
import { buildSystemPrompt, buildUserPrompt } from '../src/prompt.js';
import { transcribe } from '../src/stt.js';
import { generate } from '../src/llm.js';
import { DEFAULTS } from '../src/store.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const BLOCK = 2048;
const tone = (sec, amp = 0.1) => {
  const blocks = [];
  for (let n = 0; n < (sec * SR) / BLOCK; n++) {
    const b = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) b[i] = amp * Math.sin((2 * Math.PI * 220 * (n * BLOCK + i)) / SR);
    blocks.push(b);
  }
  return blocks;
};
const silence = (sec) => tone(sec, 0);

// ---- chunker ----
await test('chunker cuts at first pause after 18 s', () => {
  const out = [];
  const c = new Chunker('others', (src, t, pcm) => out.push({ src, t, sec: pcm.length / SR }));
  [...tone(10), ...silence(1), ...tone(9), ...silence(1), ...tone(5)].forEach((b) => c.push(b));
  // First pause at 10 s is before MIN, so cut happens at the 2nd pause (~20.35 s).
  assert.equal(out.length, 1);
  assert.equal(out[0].t, 0);
  assert.ok(out[0].sec > 19.5 && out[0].sec < 21, `sec=${out[0].sec}`);
  c.flush();
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[1].t - out[0].sec) < 1e-9, 'second chunk starts where first ended');
});

await test('chunker hard-cuts continuous speech under 30 s', () => {
  const out = [];
  const c = new Chunker('me', (src, t, pcm) => out.push(pcm.length / SR));
  tone(60).forEach((b) => c.push(b));
  assert.ok(out.length >= 2);
  assert.ok(out.every((s) => s <= 28.2), JSON.stringify(out));
});

await test('chunker drops silent and tiny chunks but keeps time aligned', () => {
  const out = [];
  const c = new Chunker('others', (src, t) => out.push(t));
  silence(29).forEach((b) => c.push(b));
  c.flush(); // silent chunks: skipped
  tone(0.5).forEach((b) => c.push(b));
  c.flush(); // 0.5 s chunk: too short, skipped
  tone(5).forEach((b) => c.push(b));
  c.flush();
  assert.equal(out.length, 1);
  assert.ok(out[0] > 29, `t=${out[0]}`);
});

// ---- wav ----
await test('wav header is 16 kHz mono PCM16', async () => {
  const blob = encodeWav(new Float32Array(SR).fill(0.5), SR);
  const v = new DataView(await blob.arrayBuffer());
  assert.equal(blob.size, 44 + SR * 2);
  assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), 'RIFF');
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), SR);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getInt16(44, true), 16383);
});

// ---- prompt ----
const meeting = {
  title: 'Weekly sync',
  startedAt: Date.parse('2026-09-30T10:00:00+05:30'),
  endedAt: Date.parse('2026-09-30T10:42:00+05:30'),
  segments: [
    { t: 65, src: 'others', text: 'Rahul, कल तक deployment हो जाएगा?' },
    { t: 3, src: 'me', text: 'Chaliye shuru karte hain.' },
  ],
};
await test('prompt orders segments and tags speakers', () => {
  const u = buildUserPrompt(meeting, { ...DEFAULTS, myName: 'Shrawin' }, 'Attendees: Rahul');
  assert.match(u, /Duration: 42 min/);
  assert.match(u, /Attendees: Rahul/);
  const iMe = u.indexOf('[00:03] ME (Shrawin): Chaliye');
  const iOt = u.indexOf('[01:05] OTHERS: Rahul');
  assert.ok(iMe > 0 && iOt > iMe, u);
  assert.match(buildSystemPrompt('English'), /Write the MOM in English/);
});

// ---- fetch mock ----
let calls = [];
let responder = null;
globalThis.fetch = async (url, init = {}) => {
  const req = new Request(url, init);
  calls.push({ url: String(url), init, req });
  return responder(req, calls.length);
};
const sse = (events, headers = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        // Split mid-line to exercise buffering.
        const text = events.join('');
        for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }
  );
const wav = encodeWav(new Float32Array(SR), SR);

// ---- STT ----
await test('stt sarvam: endpoint, header, form fields', async () => {
  calls = [];
  responder = () => Response.json({ request_id: 'x', transcript: ' नमस्ते team ' });
  const s = { ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'sk_test' };
  assert.equal(await transcribe(wav, s), 'नमस्ते team');
  const { url, req } = calls[0];
  assert.equal(url, 'https://api.sarvam.ai/speech-to-text');
  assert.equal(req.headers.get('api-subscription-key'), 'sk_test');
  const fd = await req.formData();
  assert.equal(fd.get('model'), 'saaras:v4');
  assert.equal(fd.get('mode'), 'codemix');
  assert.equal(fd.get('language_code'), 'unknown');
  assert.equal(fd.get('file').size, wav.size);
});

await test('stt deepgram: nova-3 multi, token auth, raw wav body', async () => {
  calls = [];
  responder = () => Response.json({ results: { channels: [{ alternatives: [{ transcript: 'hello ji' }] }] } });
  const s = { ...DEFAULTS, sttProvider: 'deepgram', deepgramKey: 'dg' };
  assert.equal(await transcribe(wav, s), 'hello ji');
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.deepgram.com/v1/listen');
  assert.equal(u.searchParams.get('model'), 'nova-3');
  assert.equal(u.searchParams.get('language'), 'multi');
  assert.equal(calls[0].req.headers.get('authorization'), 'Token dg');
  assert.equal(calls[0].req.headers.get('content-type'), 'audio/wav');
});

await test('stt openai-compatible: retries 500 then succeeds; no auth header when key blank', async () => {
  calls = [];
  responder = (_r, n) => (n === 1 ? new Response('busy', { status: 503 }) : Response.json({ text: 'ok bhai' }));
  const s = { ...DEFAULTS, sttProvider: 'openai', sttBase: 'http://localhost:8000/v1/', sttKey: '' };
  assert.equal(await transcribe(wav, s), 'ok bhai');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://localhost:8000/v1/audio/transcriptions');
  assert.equal(calls[1].req.headers.get('authorization'), null);
  assert.equal((await calls[1].req.formData()).get('model'), 'whisper-large-v3');
});

await test('stt does not retry 401', async () => {
  calls = [];
  responder = () => new Response('{"error":"bad key"}', { status: 401 });
  await assert.rejects(transcribe(wav, { ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'bad' }), /Sarvam HTTP 401/);
  assert.equal(calls.length, 1);
});

await test('stt gemini transcribe model: inline wav + audioTranscriptionConfig', async () => {
  calls = [];
  responder = () => Response.json({ candidates: [{ content: { parts: [{ text: 'कल तक deploy कर देंगे।' }] } }] });
  const s = { ...DEFAULTS, geminiKey: 'gk' };
  assert.equal(s.sttProvider, 'gemini');
  assert.equal(await transcribe(wav, s), 'कल तक deploy कर देंगे।');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent');
  assert.equal(calls[0].req.headers.get('x-goog-api-key'), 'gk');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.generationConfig, { audioTranscriptionConfig: { mode: 'SMART' } });
  const part = body.contents[0].parts[0].inlineData;
  assert.equal(part.mimeType, 'audio/wav');
  assert.equal(Buffer.from(part.data, 'base64').length, wav.size, 'base64 round-trips the whole WAV');
});

await test('stt gemini general model: prompt part, thought parts dropped', async () => {
  calls = [];
  responder = () => Response.json({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'ok ji' }] } }] });
  assert.equal(await transcribe(wav, { ...DEFAULTS, geminiKey: 'gk', sttGeminiModel: 'gemini-3.8-flash' }), 'ok ji');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig, undefined);
  assert.match(body.contents[0].parts[0].text, /Transcribe/);
  assert.ok(body.contents[0].parts[1].inlineData);
});

await test('chunker honours Gemini-sized chunks', () => {
  const out = [];
  const c = new Chunker('others', (src, t, pcm) => out.push(pcm.length / SR), { minSec: 100, maxSec: 150 });
  [...tone(110), ...silence(1), ...tone(200)].forEach((b) => c.push(b));
  assert.ok(out[0] > 110 && out[0] < 111.5, `first=${out[0]}`);
  assert.ok(out[1] <= 150.2 && out[1] > 149, `second=${out[1]}`);
});

await test('gemini backup key used on 429, not used on success', async () => {
  calls = [];
  responder = (req, n) => (n === 1 ? new Response('{"error":{"code":429}}', { status: 429 }) : Response.json({ candidates: [{ content: { parts: [{ text: 'from backup' }] } }] }));
  const s = { ...DEFAULTS, geminiKey: 'main', geminiKey2: 'backup' };
  assert.equal(await transcribe(wav, s), 'from backup');
  assert.deepEqual(calls.map((c) => c.req.headers.get('x-goog-api-key')), ['main', 'backup']);
  calls = [];
  responder = () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  await transcribe(wav, s);
  assert.equal(calls.length, 1);
});

await test('gemini backup key used for MOM streaming when main key is invalid', async () => {
  calls = [];
  responder = (req, n) => (n === 1 ? new Response('{"error":{"message":"API key not valid"}}', { status: 400 }) : sse(['data: {"candidates":[{"content":{"parts":[{"text":"# MOM"}]}}]}\n\n']));
  const text = await generate({ settings: { ...DEFAULTS, geminiKey: 'bad', geminiKey2: 'good' }, system: 'S', user: 'U', onText: () => {} });
  assert.equal(text, '# MOM');
  assert.equal(calls[1].req.headers.get('x-goog-api-key'), 'good');
});

// ---- LLM ----
const collect = () => {
  const parts = [];
  return { parts, onText: (d) => parts.push(d) };
};

await test('llm openai-compatible streams chat completions', async () => {
  calls = [];
  responder = () =>
    sse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"# Weekly"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" sync"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  const c = collect();
  const text = await generate({ settings: { ...DEFAULTS, llmProvider: 'openai', oaKey: 'k', oaModel: 'm1' }, system: 'S', user: 'U', onText: c.onText });
  assert.equal(text, '# Weekly sync');
  assert.equal(c.parts.join(''), text);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'm1');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
});

await test('llm gemini streams and skips thought parts', async () => {
  calls = [];
  responder = () =>
    sse([
      'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"## Summary"}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"\\n- one"}]}}]}\r\n\r\n',
    ]);
  const text = await generate({ settings: { ...DEFAULTS, llmProvider: 'gemini', geminiKey: 'g', geminiModel: 'gem-x' }, system: 'S', user: 'U', onText: () => {} });
  assert.equal(text, '## Summary\n- one');
  assert.match(calls[0].url, /models\/gem-x:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].req.headers.get('x-goog-api-key'), 'g');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.systemInstruction.parts[0].text, 'S');
});

const anthropicStream = (texts, stop = 'end_turn') => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return sse([
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    ...texts.map((t) => ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { index: 1 }),
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev('message_stop', {}),
  ], { 'request-id': 'req_test' });
};

await test('llm anthropic: SDK request shape (adaptive thinking, effort, fallbacks) and streaming', async () => {
  calls = [];
  responder = () => anthropicStream(['# MOM', '\n\n## Summary']);
  const c = collect();
  const text = await generate({ settings: { ...DEFAULTS, llmProvider: 'anthropic', anthropicKey: 'sk-ant-test' }, system: 'SYS', user: 'USR', onText: c.onText });
  assert.equal(text, '# MOM\n\n## Summary');
  assert.equal(c.parts.join(''), text);
  const { req, init } = calls[0];
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages\?beta=true$/);
  assert.equal(req.headers.get('x-api-key'), 'sk-ant-test');
  assert.equal(req.headers.get('anthropic-dangerous-direct-browser-access'), 'true');
  assert.match(req.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal(body.system, 'SYS');
  assert.equal(body.betas, undefined, 'betas must go in the header, not the body');
});

await test('llm anthropic: haiku gets a plain request', async () => {
  calls = [];
  responder = () => anthropicStream(['ok']);
  await generate({ settings: { ...DEFAULTS, llmProvider: 'anthropic', anthropicKey: 'k', anthropicModel: 'claude-haiku-4-5' }, system: 'S', user: 'U', onText: () => {} });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.thinking, undefined);
  assert.equal(body.fallbacks, undefined);
});

await test('llm anthropic: refusal surfaces as an error', async () => {
  responder = () => anthropicStream([], 'refusal');
  await assert.rejects(generate({ settings: { ...DEFAULTS, llmProvider: 'anthropic', anthropicKey: 'k' }, system: 'S', user: 'U', onText: () => {} }), /declined/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);

// ---- loop-noise filter ----
const { isLoopNoise } = await import('../src/noise.js');
await test('noise filter drops looped filler but keeps real speech', () => {
  const loop = 'एक तो तो वो तो तो वो '.repeat(8);
  assert.equal(isLoopNoise(loop), true);
  assert.equal(isLoopNoise('yes yes yes yes yes yes yes yes yes yes yes yes yes yes'), true);
  assert.equal(isLoopNoise('ठीक है, आधार वाला भेज दो उनको I think. ग्रुप में ही है।'), false);
  assert.equal(isLoopNoise('So, as you can see, this is our Sandbox portal. As you log in, you will see start building and explore our services, okay?'), false);
  assert.equal(isLoopNoise('हाँ हाँ ठीक है'), false);
});

// ---- alert classifier ----
const { classifyError } = await import('../src/alerts.js');
await test('alerts classify quota and key errors, ignore the rest', () => {
  const q = classifyError('[100s me] Gemini HTTP 429: You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash Please retry in 18h7m44.2s');
  assert.equal(q.kind, 'quota');
  assert.match(q.detail, /gemini-3\.8-flash/);
  assert.match(q.detail, /18h7m44/);
  assert.equal(classifyError('Gemini HTTP 400: API key not valid. Please pass a valid API key.').kind, 'key');
  assert.equal(classifyError('Failed to fetch'), null);
  assert.equal(classifyError('Gemini HTTP 404: model gone'), null);
});
