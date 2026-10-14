// Voice fingerprints: the JavaScript front end and model runner must agree with the reference numbers.
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

const ref = JSON.parse(fs.readFileSync(new URL('./fixtures/fbank-ref.json', import.meta.url), 'utf8'));
const synth = (n = 24000) => {
  const out = new Float32Array(n);
  let st = 12345;
  for (let i = 0; i < n; i++) {
    st = Number((BigInt(st) * 1103515245n + 12345n) & 0x7fffffffn);
    const noise = (st / 0x7fffffff) * 2 - 1;
    out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 0.2 * Math.sin((2 * Math.PI * 1370 * i) / 16000) + 0.1 * Math.sin((2 * Math.PI * 3100 * i) / 16000) + 0.05 * noise;
  }
  return out;
};

const { fbank } = await import('../src/voice/fbank.js');
const cosine = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));

await test('voice: the JavaScript filterbank matches the reference implementation', () => {
  const { data, frames } = fbank(synth(ref.samples));
  assert.equal(frames, ref.frames);
  ref.pick.forEach((fi, k) => {
    const row = Array.from(data.slice(fi * 80, fi * 80 + 80));
    const worst = Math.max(...row.map((v, i) => Math.abs(v - ref.rows[k][i])));
    assert.ok(worst < 0.01, `frame ${fi}: worst difference ${worst}`);
  });
  let abs = 0;
  for (const v of data) abs += Math.abs(v);
  assert.ok(Math.abs(abs / data.length - ref.colMeanAbs) < 0.005);
});

await test('voice: short or silent input gives no fingerprint instead of garbage', async () => {
  const { createEmbedder } = await import('../src/voice/embedder.js');
  const e = await createEmbedder({ model: fs.readFileSync(new URL('../extension/models/wespeaker_resnet34_lm.onnx', import.meta.url)), wasmPaths: new URL('../extension/vendor/ort/', import.meta.url).href });
  assert.equal(await e.embed(new Float32Array(8000)), null);
  const fp = await e.embed(synth(ref.samples));
  assert.equal(fp.length, 256);
  assert.ok(Math.abs(Math.hypot(...fp) - 1) < 1e-4, 'unit length');
  // The same audio through the Python reference chain gives the same fingerprint.
  const c = cosine(Array.from(fp), ref.emb);
  assert.ok(c > 0.995, `agreement with the reference fingerprint: ${c}`);
  const other = synth(ref.samples).map((v, i) => v * Math.sin(i / 900));
  const fp2 = await e.embed(other);
  assert.ok(cosine(Array.from(fp), Array.from(fp2)) < 0.9999, 'a different signal gives a different fingerprint');
});

console.log(`\n${passed} passed`);
