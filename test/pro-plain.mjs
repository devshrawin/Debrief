// chrome.storage refuses typed arrays ("Cannot serialize value to JSON"): plain() turns them into ordinary arrays and findTyped() finds them.
import assert from 'node:assert/strict';
import { plain, findTyped } from '../src/store.js';

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

await test('typed arrays anywhere in a value become plain arrays; everything else is unchanged', () => {
  const v = { a: [1, 'x', { b: new Float32Array([0.5, 1]) }], c: new Int8Array([1, -2]), d: { e: null, f: true } };
  const p = plain(v);
  assert.deepEqual(p.a[2].b, [0.5, 1]);
  assert.deepEqual(p.c, [1, -2]);
  assert.equal(p.d.f, true);
  assert.ok(!findTyped(p));
});

await test('findTyped says where the typed array is', () => {
  assert.equal(findTyped([{ name: 'x', centroid: 'abc' }, { windows: [new Float32Array(2)] }]), '1.windows.0');
  assert.equal(findTyped({ a: { b: 1 } }), '');
});

console.log(`\n${passed} passed`);
