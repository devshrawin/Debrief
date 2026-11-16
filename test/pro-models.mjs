// Model-name checks against provider lists, and the speaker model loader (bundled / cache / download). Fake fetch only.
import assert from 'node:assert/strict';

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

const { listModels, checkConfigured, usableChain, summary, cachedList, clearListCache, closest } = await import('../src/models.js');
const ms = await import('../src/voice/modelstore.js');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
const fake = (routes) => {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = routes(String(url), init);
    if (r instanceof Error) throw r;
    return r;
  };
  f.calls = calls;
  return f;
};
const gem = (ids) => ({ models: ids.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) });

await test('gemini list follows pagination and sends the key as a header', async () => {
  const f = fake((u) => (u.includes('pageToken=p2') ? json(gem(['gemini-3.7-flash'])) : json({ ...gem(['gemini-3.5-flash']), nextPageToken: 'p2' })));
  const r = await listModels('gemini', { geminiKey: KEY, geminiBackups: ['b'] }, { fetch: f });
  assert.deepEqual(r.models.map((m) => m.id), ['gemini-3.5-flash', 'gemini-3.7-flash']);
  assert.equal(r.models[0].generate, true);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'));
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], KEY);
  assert.ok(!f.calls[0].url.includes(KEY));
  assert.ok(!JSON.stringify(r).includes(KEY));
});

await test('gemini pagination stops after 5 pages', async () => {
  const f = fake(() => json({ ...gem(['gemini-3.5-flash']), nextPageToken: 'more' }));
  await listModels('gemini', { geminiKey: KEY }, { fetch: f });
  assert.equal(f.calls.length, 5);
});

await test('anthropic list uses the same headers as the minutes writer', async () => {
  const f = fake(() => json({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }));
  const r = await listModels('anthropic', { anthropicKey: 'sk-ant-secret-secret-1' }, { fetch: f });
  assert.deepEqual(r.models, [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }]);
  const h = f.calls[0].init.headers;
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(h['x-api-key'], 'sk-ant-secret-secret-1');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
});

await test('openai-compatible: chat and speech use their own address and key; no key means no header', async () => {
  const f = fake(() => json({ data: [{ id: 'whisper-large-v3' }] }));
  const s = { oaBase: 'http://localhost:11434/v1/', oaKey: '', sttBase: 'https://api.groq.com/openai/v1', sttKey: 'gsk_secretsecret' };
  const a = await listModels('openai', s, { fetch: f });
  const b = await listModels('openai-speech', s, { fetch: f });
  assert.equal(f.calls[0].url, 'http://localhost:11434/v1/models');
  assert.equal(f.calls[0].init.headers.authorization, undefined);
  assert.equal(f.calls[1].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(f.calls[1].init.headers.authorization, 'Bearer gsk_secretsecret');
  assert.deepEqual(a.models, [{ id: 'whisper-large-v3' }]);
  assert.ok(!JSON.stringify(b).includes('gsk_secretsecret'));
});

await test('404, network error and a key echoed in an error body are all ok:false without the key', async () => {
  const r404 = await listModels('openai', { oaBase: 'http://x/v1' }, { fetch: fake(() => json({}, 404)) });
  assert.equal(r404.ok, false);
  assert.equal(r404.status, 404);
  const rn = await listModels('openai', { oaBase: 'http://x/v1' }, { fetch: fake(() => new Error('connect ECONNREFUSED')) });
  assert.equal(rn.ok, false);
  const re = await listModels('gemini', { geminiKey: KEY }, { fetch: fake(() => json({ error: { message: `API key not valid: ${KEY}` } }, 400)) });
  assert.equal(re.ok, false);
  assert.ok(!JSON.stringify(re).includes(KEY), JSON.stringify(re));
  const rk = await listModels('anthropic', { anthropicKey: 'sk-ant-abcdefghijklmnop' }, { fetch: fake(() => new Error('failed for sk-ant-abcdefghijklmnop')) });
  assert.ok(!JSON.stringify(rk).includes('abcdefghijklmnop'));
});

await test('deepgram and sarvam have no list and make no call', async () => {
  const f = fake(() => json({}));
  for (const p of ['deepgram', 'sarvam']) {
    const r = await listModels(p, { deepgramKey: 'k' }, { fetch: f });
    assert.deepEqual(r, { ok: false, error: 'This provider has no model list to check against.' });
  }
  assert.equal(f.calls.length, 0);
});

const avail = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.7-flash-preview-0901'];
await test('suggestion: highest stable of the same family, never a preview', () => {
  assert.equal(closest('gemini-3.8-flash', avail), 'gemini-3.7-flash');
  assert.equal(closest('gemini-3.8-flash', ['gemini-3.7-flash-preview-0901']), 'gemini-3.7-flash-preview-0901');
  assert.equal(closest('gemini-3.8-transcribe', [...avail, 'gemini-3.5-transcribe', 'gemini-3.6-transcribe']), 'gemini-3.6-transcribe');
  assert.equal(closest('gemini-3.8-flash', ['gemini-3.7-flash-lite']), undefined);
  assert.equal(closest('claude-opus-5-5', ['claude-opus-5-4', 'claude-opus-4-1', 'claude-sonnet-5-5', 'claude-opus-5-4-20260101']), 'claude-opus-5-4');
});

const gemSettings = { sttProvider: 'gemini', llmProvider: 'gemini', geminiKey: KEY, sttGeminiModel: 'gemini-3.5-transcribe', geminiModel: 'gemini-3.8-flash' };

await test('checkConfigured: missing with suggestion, ok, fallback chain, summary line', async () => {
  clearListCache();
  const f = fake(() => json(gem([...avail, 'gemini-3.5-transcribe', 'gemini-3.5-flash-lite'])));
  const r = await checkConfigured(gemSettings, { fetch: f });
  assert.equal(f.calls.length, 1); // one list serves both roles
  const by = (role, id) => r.find((x) => x.role === role && x.id === id);
  assert.equal(by('speech', 'gemini-3.5-transcribe').state, 'ok');
  assert.equal(by('minutes', 'gemini-3.8-flash').state, 'missing');
  assert.equal(by('minutes', 'gemini-3.8-flash').suggestion, 'gemini-3.7-flash');
  assert.equal(r.filter((x) => x.role === 'fallback').length, 0); // all four fallbacks exist
  assert.deepEqual(summary(r), ['Minutes model "gemini-3.8-flash" is not in your Google account\'s model list. Closest available: "gemini-3.7-flash".']);
  clearListCache();
  const g = await checkConfigured({ ...gemSettings, geminiModel: 'gemini-3.7-flash' }, { fetch: fake(() => json(gem(['gemini-3.7-flash', 'gemini-3.5-transcribe']))) });
  assert.deepEqual(g.filter((x) => x.role === 'fallback').map((x) => x.id).sort(), ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']);
  assert.ok(g.every((x) => x.state !== 'unknown'));
});

await test('checkConfigured: transcribe suggestion and claude family', async () => {
  clearListCache();
  const f = fake((u) => (u.includes('anthropic') ? json({ data: [{ id: 'claude-opus-5-4' }, { id: 'claude-sonnet-5-5' }] }) : json(gem(['gemini-3.6-transcribe', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']))));
  const r = await checkConfigured({ sttProvider: 'gemini', llmProvider: 'anthropic', geminiKey: KEY, anthropicKey: 'sk-ant-xxxxxxxxxxxxxxx', sttGeminiModel: 'gemini-3.8-transcribe', anthropicModel: 'claude-opus-5-5' }, { fetch: f });
  assert.equal(r.find((x) => x.role === 'speech').suggestion, 'gemini-3.6-transcribe');
  assert.equal(r.find((x) => x.role === 'minutes').suggestion, 'claude-opus-5-4');
});

await test('checkConfigured: unknown when no list is available', async () => {
  clearListCache();
  const r = await checkConfigured({ sttProvider: 'deepgram', deepgramKey: 'k', deepgramModel: 'nova-3', llmProvider: 'openai', oaBase: 'http://localhost:1234/v1', oaModel: 'llama' }, { fetch: fake(() => json({}, 404)) });
  assert.deepEqual(r.map((x) => [x.role, x.state]), [['speech', 'unknown'], ['minutes', 'unknown']]);
  assert.deepEqual(summary(r), []);
});

await test('usableChain keeps the primary first and drops ids that do not exist', () => {
  assert.deepEqual(usableChain(['a', 'b', 'c'], ['c', 'b']), ['a', 'b', 'c']);
  assert.deepEqual(usableChain(['a', 'b', 'c'], [{ id: 'c' }]), ['a', 'c']);
  assert.deepEqual(usableChain(['a', 'b'], null), ['a', 'b']);
});

await test('cache: a second call does not fetch; a failure is not cached; no key is stored', async () => {
  clearListCache();
  const saved = {};
  globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: saved[k] }), set: async (o) => Object.assign(saved, o) } } };
  try {
    let ok = false;
    const f = fake(() => (ok ? json(gem(['gemini-3.7-flash'])) : json({}, 500)));
    assert.equal((await cachedList('gemini', { geminiKey: KEY }, { fetch: f })).ok, false);
    assert.equal(saved.modelLists, undefined);
    ok = true;
    assert.equal((await cachedList('gemini', { geminiKey: KEY }, { fetch: f })).ok, true);
    const again = await cachedList('gemini', { geminiKey: KEY }, { fetch: f });
    assert.equal(again.cached, true);
    assert.equal(f.calls.length, 2);
    assert.ok(!JSON.stringify(saved).includes(KEY));
    clearListCache(); // a fresh worker still hits chrome.storage
    await cachedList('gemini', { geminiKey: KEY }, { fetch: f });
    assert.equal(f.calls.length, 2);
    clearListCache();
    await cachedList('gemini', { geminiKey: KEY }, { fetch: f, now: () => Date.now() + 7 * 3600 * 1000 });
    assert.equal(f.calls.length, 3); // older than 6 hours
  } finally {
    delete globalThis.chrome;
  }
});

// ---- speaker model loader ----
const MB = 1048576;
const blob = (n, first = 0x08) => {
  const b = new Uint8Array(n);
  b[0] = first;
  for (let i = 1; i < n; i++) b[i] = (i * 31) & 0xff;
  return b;
};
const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
function cachesStub() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return { match: async (k) => m.get(k)?.clone(), put: async (k, r) => void m.set(k, r), matchAll: async () => [...m.values()].map((r) => r.clone()) };
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
}
const respond = (bytes, { status = 200, type = 'application/octet-stream', chunk = 4 * MB } = {}) => {
  let at = 0;
  return {
    ok: status < 400,
    status,
    headers: { get: (h) => (/content-type/i.test(h) ? type : /content-length/i.test(h) ? String(bytes.length) : null) },
    body: { getReader: () => ({ read: async () => (at >= bytes.length ? { done: true } : { done: false, value: bytes.subarray(at, (at += chunk)) }), cancel() {} }) },
  };
};
const URL1 = 'https://models.example.com/wespeaker.onnx';
const base = { bundledUrl: 'chrome-extension://x/models/m.onnx' };

await test('model constants match the bundled file', async () => {
  const { readFileSync } = await import('node:fs');
  const b = readFileSync(new URL('../extension/models/wespeaker_resnet34_lm.onnx', import.meta.url));
  assert.equal(b.length, ms.MODEL_BYTES);
  assert.equal(await sha(b), ms.MODEL_SHA256);
});

await test('model: bundled file present -> used, nothing downloaded', async () => {
  const f = fake(() => ({ ok: true, status: 200 }));
  const r = await ms.resolveModel({ ...base, downloadUrl: URL1, fetch: f, caches: cachesStub() });
  assert.deepEqual(r, { url: base.bundledUrl, source: 'bundled' });
  assert.equal(f.calls.length, 1);
});

await test('model: bundled missing, download ok with progress, hash checked, cached, then served from cache', async () => {
  const bytes = blob(8 * MB);
  const c = cachesStub();
  const f = fake((u) => (u === base.bundledUrl ? { ok: false, status: 404 } : respond(bytes)));
  const seen = [];
  const r = await ms.resolveModel({ ...base, downloadUrl: URL1, expectedSha256: await sha(bytes), onProgress: (a, t) => seen.push([a, t]), fetch: f, caches: c });
  assert.equal(r.source, 'download');
  assert.equal(r.bytes.length, bytes.length);
  assert.deepEqual(seen.at(-1), [bytes.length, bytes.length]);
  assert.ok(seen.length >= 2);
  const n = f.calls.length;
  const r2 = await ms.resolveModel({ ...base, downloadUrl: URL1, fetch: f, caches: c });
  assert.equal(r2.source, 'cache');
  assert.equal(r2.bytes.length, bytes.length);
  assert.equal(f.calls.length, n + 2); // only the two bundled probes (HEAD, ranged GET)
  const st = await ms.modelStatus({ ...base, downloadUrl: URL1, fetch: f, caches: c });
  assert.deepEqual(st, { bundled: false, cached: true, bytes: bytes.length });
  assert.equal(await ms.removeModel({ caches: c }), true);
  assert.equal((await ms.modelStatus({ ...base, downloadUrl: URL1, fetch: f, caches: c })).cached, false);
});

const missing = (body, extra = {}) => ({ ...base, downloadUrl: URL1, caches: cachesStub(), fetch: fake((u) => (u === base.bundledUrl ? { ok: false, status: 404 } : body)), ...extra });

await test('model: wrong hash is rejected and not cached', async () => {
  const o = missing(respond(blob(8 * MB)), { expectedSha256: 'ab'.repeat(32) });
  await assert.rejects(ms.resolveModel(o), /checksum/);
  assert.equal((await ms.modelStatus({ ...base, downloadUrl: URL1, caches: o.caches, fetch: o.fetch })).cached, false);
});

await test('model: an HTML error page is rejected (by type and by first byte)', async () => {
  await assert.rejects(ms.resolveModel(missing(respond(blob(8 * MB), { type: 'text/html; charset=utf-8' }))), /web page/);
  await assert.rejects(ms.resolveModel(missing(respond(blob(8 * MB, 0x3c)))), /does not look like/);
});

await test('model: too small and too large are rejected', async () => {
  await assert.rejects(ms.resolveModel(missing(respond(blob(1 * MB)))), /right size/);
  await assert.rejects(ms.resolveModel(missing(respond(blob(81 * MB)))), /right size/);
});

await test('model: non-https address is rejected; http error status is reported', async () => {
  await assert.rejects(ms.resolveModel(missing(respond(blob(8 * MB)), { downloadUrl: 'http://models.example.com/m.onnx' })), /https/);
  await assert.rejects(ms.resolveModel(missing(respond(blob(8 * MB), { status: 404 }))), /HTTP 404/);
});

await test('model: nothing bundled and no address -> the clear error', async () => {
  for (const downloadUrl of ['', undefined]) {
    const f = fake(() => ({ ok: false, status: 404 }));
    await assert.rejects(ms.resolveModel({ ...base, downloadUrl, fetch: f, caches: cachesStub() }), (e) => e.message === 'The speaker model is not installed. Add its address in Settings → Voices, or install the full version of Debrief.');
    assert.equal(f.calls.length, 2); // never anything but the bundled probes
  }
});

await test('voice client with no download address still reads modelUrl directly', async () => {
  const seen = [];
  globalThis.Worker = class {
    constructor() { this.t = null; }
    postMessage(m) { seen.push(m); setTimeout(() => this.onmessage({ data: { ready: true } })); }
    terminate() {}
  };
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => (calls.push(u), { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  try {
    const { createVoiceClient } = await import('../src/voice/client.js');
    const c = createVoiceClient({ workerUrl: 'w.js', modelUrl: 'm.onnx', wasmPaths: 'p/' });
    await c.ready;
    assert.deepEqual(calls, ['m.onnx']);
    assert.deepEqual([...seen[0].model], [1, 2, 3]);
    c.close();
    globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const d = createVoiceClient({ workerUrl: 'w.js', modelUrl: 'm.onnx', wasmPaths: 'p/' });
    await assert.rejects(d.ready, /not installed/);
    d.close();
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.Worker;
  }
});

console.log(process.exitCode ? `\n${passed} passed, some FAILED` : `\n${passed} passed`);
