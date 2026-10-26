// The audio-clip pipeline for unnamed voices, run against an in-memory IndexedDB (fake-indexeddb): pieces wait while the
// meeting is recorded, one clip per unnamed voice is cut after it, the waiting audio is deleted, and clips go when a voice
// is named, deleted or forgotten. Synthetic audio only: it shows the bookkeeping works, not that real clips sound good.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import * as V from '../src/voice/match.js';
import * as L from '../src/voice/learn.js';
import * as S from '../src/voice/samples.js';
import { saveSamples } from '../src/voice/sampling.js';

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

let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const base = (k) => {
  seed = 900 + k * 71;
  return V.normalize(Float32Array.from({ length: 256 }, rnd));
};
const B = { 1: base(1), 2: base(2) };
const near = (b) => V.normalize(Float32Array.from(b, (x) => x + (1.2 * rnd()) / 16));
const tone = (sec, f) => Float32Array.from({ length: Math.round(sec * 16000) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / 16000));

// a meeting of two voices, 16 pieces each; audio pieces stored the way the recorder stores them
async function recordMeeting(id) {
  const voiceSegs = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 16; i++) {
      const t0 = k * 100 + i * 4;
      voiceSegs.push({ t0, t1: t0 + 3, e: V.pack(near(B[k + 1])) });
      await S.putPiece(S.pieceKey(id, t0), S.toInt16(tone(3, 200 + 150 * k)));
    }
  }
  return { id, voiceSegs, captions: [], segments: [] };
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

await test('clips: each unnamed voice gets one playable clip of at most 8 s, and the waiting audio is deleted', async () => {
  const m = await recordMeeting('m1');
  const { list } = L.learnRecurring(m, []);
  assert.equal(list.length, 2);
  assert.equal(await S.hasSample(list[0].id), false);
  await saveSamples('m1', m, list);
  for (const p of list) {
    const blob = await S.getSample(p.id);
    assert.ok(blob, `a clip for ${p.name}`);
    const bytes = await bytesOf(blob);
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
    const seconds = (bytes.length - 44) / 32000;
    assert.ok(seconds > 2 && seconds <= S.CLIP_SEC + 0.01, `${seconds}s`);
  }
  // the two clips are of different voices (different tones were stored for each)
  const [a, b] = await Promise.all(list.map(async (p) => bytesOf(await S.getSample(p.id))));
  assert.notDeepEqual(Array.from(a.slice(1000, 1100)), Array.from(b.slice(1000, 1100)));
  assert.equal(await S.getPiece(S.pieceKey('m1', 0)), undefined, 'waiting pieces are gone after the clips are cut');
  assert.equal(await S.getPiece(S.pieceKey('m1', 100)), undefined);
});

await test('clips: with sampling switched off nothing is kept, and waiting audio is still deleted', async () => {
  const m = await recordMeeting('m2');
  const { list } = L.learnRecurring(m, []);
  await saveSamples('m2', null, list);
  assert.equal(await S.hasSample(list[0].id), false);
  assert.equal(await S.getPiece(S.pieceKey('m2', 0)), undefined);
});

await test('clips: naming keeps the clip, a deleted voice loses it, and forget-all clears everything', async () => {
  const m = await recordMeeting('m3');
  const { list } = L.learnRecurring(m, []);
  await saveSamples('m3', m, list);
  assert.ok(await S.hasSample(list[0].id));
  await S.deleteSample(list[0].id); // what Delete does
  assert.equal(await S.hasSample(list[0].id), false);
  assert.ok(await S.hasSample(list[1].id));
  await S.clearAllAudio(); // Forget all voices
  assert.equal(await S.hasSample(list[1].id), false);
});

await test('clips: a voice that already has a clip keeps it, and a named voice gets one too (so it can be played in Settings)', async () => {
  const m = await recordMeeting('m4');
  const { list } = L.learnRecurring(m, []);
  await saveSamples('m4', m, list);
  const first = await bytesOf(await S.getSample(list[0].id));
  const m5 = await recordMeeting('m5');
  await saveSamples('m5', m5, list);
  assert.deepEqual(Array.from(await bytesOf(await S.getSample(list[0].id))), Array.from(first), 'not overwritten');
  const named = list.map((p, i) => (i === 0 ? { ...p, name: 'Akash Behera', confirmed: true } : p));
  await S.clearAllAudio();
  const m6 = await recordMeeting('m6');
  await saveSamples('m6', m6, named);
  assert.ok(await S.hasSample(named[0].id), 'named: clip kept for Settings');
  assert.ok(await S.hasSample(named[1].id), 'still unnamed: clip');
});

await test('clips: voices nobody has named yet (the "name this voice" list) get a playable clip too, and it goes with the meeting', async () => {
  const m = await recordMeeting('m7');
  await saveSamples('m7', m, []); // no one is known yet
  const groups = L.unnamedGroups(m, [], { max: 6 });
  assert.ok(groups.length >= 1, 'there are unnamed voices');
  for (const g of groups) {
    const blob = await S.getSample(S.unnamedKey('m7', g.at[0]));
    assert.ok(blob, 'a clip for the unnamed voice');
    const bytes = await bytesOf(blob);
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  }
  await S.deleteUnnamedClips('m7');
  assert.equal(await S.hasSample(S.unnamedKey('m7', groups[0].at[0])), false);
});

console.log(`\n${passed} passed`);
