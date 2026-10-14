// Learning voices from meetings on its own: the rules, with synthetic fingerprints and synthetic captions.
// These tests show the bookkeeping is right (who counts as evidence, when a voice is trusted, what is refused).
// They do NOT show that real captions line up with real speech this well: that needs real Meet recordings.
import assert from 'node:assert/strict';
import * as V from '../src/voice/match.js';
import * as L from '../src/voice/learn.js';

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

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const base = (k) => {
  seed = 500 + k * 131;
  return V.normalize(Float32Array.from({ length: 256 }, rnd));
};
const B = { 1: base(1), 2: base(2), 3: base(3) };
const near = (b) => V.normalize(Float32Array.from(b, (x) => x + (1.2 * rnd()) / 16));
const piece = (t0, who, len = 3) => ({ t0, t1: t0 + len, e: V.pack(near(B[who])) });

// A meeting: person 1 (Amal Raj) speaks 0-60, person 2 (Priya Nair) speaks 60-120; captions name them.
function meeting(id, { who1 = 'Amal Raj', who2 = 'Priya Nair', swap = false, offset = 0 } = {}) {
  const voiceSegs = [];
  for (let t = 0; t < 60; t += 3.5) voiceSegs.push(piece(offset + t, swap ? 2 : 1));
  for (let t = 60; t < 120; t += 3.5) voiceSegs.push(piece(offset + t, swap ? 1 : 2));
  const captions = [
    { t: offset - 1, t2: offset + 60, name: who1, text: 'blah' },
    { t: offset + 59, t2: offset + 121, name: who2, text: 'blah' },
  ];
  return { id, voiceSegs, captions, segments: [] };
}

await test('learn: pieces inside exactly one speaker caption count, and the learned voice waits for a second meeting', () => {
  const r = L.learnFromMeeting(meeting('m1'), [], { myName: 'Shrawin' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.list.map((p) => p.name).sort(), ['Amal Raj', 'Priya Nair']);
  const amal = r.list.find((p) => p.name === 'Amal Raj');
  assert.equal(amal.auto, true);
  assert.ok(amal.secs >= 30 && amal.secs < 60, `secs ${amal.secs}`);
  assert.equal(amal.ready, false, 'one meeting is never enough to trust a voice');
  assert.deepEqual(L.usableVoices(r.list), [], 'not used for naming yet');
  assert.ok(V.cosine(V.unpack(amal.centroid), B[1]) > 0.8);
});

await test('learn: a second meeting adds to the same person and makes the voice ready, once per meeting only', () => {
  const a = L.learnFromMeeting(meeting('m1'), [], {});
  const b = L.learnFromMeeting(meeting('m2'), a.list, {});
  const amal = b.list.find((p) => p.name === 'Amal Raj');
  assert.equal(amal.meetings, 2);
  assert.equal(amal.ready, true);
  assert.equal(L.usableVoices(b.list).length, 2);
  assert.equal(b.list.length, 2, 'same person, not a duplicate');
  const again = L.learnFromMeeting(meeting('m2'), b.list, {});
  assert.equal(again.list.find((p) => p.name === 'Amal Raj').secs, amal.secs, 'the same meeting is never counted twice');
});

await test('learn: pieces near another speaker caption, or without any caption, are not used as evidence', () => {
  const m = meeting('m3');
  m.captions.push({ t: 20, t2: 24, name: 'Someone Else', text: 'x' }); // interrupts Amal's stretch
  const ev = L.evidence(m, {});
  const amalSegs = ev.get('amal raj').segs.length;
  const clean = L.evidence(meeting('m3'), {}).get('amal raj').segs.length;
  assert.ok(amalSegs < clean, `${amalSegs} < ${clean}`);
  assert.ok(ev.get('amal raj').segs.every((s) => s.t1 <= 18.5 || s.t0 >= 25.5), 'nothing from around the interruption');
  assert.equal(L.evidence({ voiceSegs: [piece(0, 1)], captions: [] }, {}).size, 0);
});

await test('learn: the note-taker ("You") is never learned from the other side of the call', () => {
  const m = meeting('m4', { who1: 'You' });
  const r = L.learnFromMeeting(m, [], { myName: 'Shrawin Sisodia' });
  assert.deepEqual(r.list.map((p) => p.name), ['Priya Nair']);
  const named = L.learnFromMeeting(meeting('m5', { who1: 'Shrawin Sisodia' }), [], { myName: 'shrawin sisodia' });
  assert.deepEqual(named.list.map((p) => p.name), ['Priya Nair']);
});

await test('learn: two different names with the same voice are both refused (captions or room mix-up)', () => {
  const m = meeting('m6');
  m.voiceSegs = m.voiceSegs.map((s) => ({ ...s, e: V.pack(near(B[1])) })); // everyone sounds like voice 1
  const r = L.learnFromMeeting(m, [], {});
  assert.equal(r.list.length, 0);
  assert.ok(r.report.skipped.some((s) => /sounded the same/.test(s.why)));
});

await test('learn: a voice you recorded yourself is never changed, and a rival with someone else is refused', () => {
  const mine = [{ id: 'x', name: 'Amal Raj', centroid: V.pack(B[3]), windows: [V.pack(B[3])], secs: 20, lang: 'en' }];
  const r = L.learnFromMeeting(meeting('m7'), mine, {});
  assert.equal(r.list.find((p) => p.name === 'Amal Raj').centroid, mine[0].centroid);
  assert.ok(r.report.skipped.some((s) => /recorded this voice yourself/.test(s.why)));
  // Priya's evidence sounding like an enrolled "Ravi" is not learned as Priya
  const ravi = [{ id: 'r', name: 'Ravi K', centroid: V.pack(B[2]), windows: [V.pack(B[2])], secs: 30, lang: 'en' }];
  const r2 = L.learnFromMeeting(meeting('m8'), ravi, {});
  assert.ok(!r2.list.some((p) => p.name === 'Priya Nair'));
  assert.ok(r2.report.skipped.some((s) => /sounds the same as Ravi K/.test(s.why)));
});

await test('learn: too little evidence, and meetings without captions, learn nothing and say why', () => {
  const small = { id: 's', captions: [{ t: 0, t2: 20, name: 'Amal Raj', text: 'x' }], voiceSegs: [piece(1, 1), piece(5, 1), piece(9, 1)] };
  const r = L.learnFromMeeting(small, [], {});
  assert.equal(r.list.length, 0);
  assert.match(r.report.skipped[0].why, /clean pieces/);
  const none = L.learnFromMeeting({ id: 'n', voiceSegs: [piece(0, 1)], captions: [] }, [], {});
  assert.match(none.report.skipped[0].why, /no captions/);
});

await test('learn: odd pieces (a cough, a second voice) in one person evidence are thrown out', () => {
  const m = meeting('m9');
  m.voiceSegs[2] = { ...m.voiceSegs[2], e: V.pack(near(B[3])) };
  const r = L.learnFromMeeting(m, [], {});
  const amal = r.list.find((p) => p.name === 'Amal Raj');
  assert.ok(V.cosine(V.unpack(amal.centroid), B[1]) > 0.8);
  const full = L.learnFromMeeting(meeting('m9b'), [], {}).list.find((p) => p.name === 'Amal Raj');
  assert.ok(amal.secs < full.secs, 'the odd piece is not counted');
});

await test('learn: unnamed voices in a meeting are grouped, known ones are left out, learning voices are not "known"', () => {
  const m = { voiceSegs: [...Array(8).keys()].map((i) => piece(i * 4, 1)).concat([...Array(8).keys()].map((i) => piece(40 + i * 4, 2))) };
  const amal = { id: 'a', name: 'Amal Raj', centroid: V.pack(B[1]), windows: [V.pack(B[1])], secs: 30 };
  const g = L.unnamedGroups(m, [amal]);
  assert.equal(g.length, 1, 'only voice 2 is unnamed');
  assert.ok(V.cosine(V.unpack(g[0].centroid), B[2]) > 0.8);
  assert.ok(g[0].windows.length >= 1 && g[0].at.length >= 1);
  const learning = { ...amal, auto: true, ready: false };
  assert.equal(L.unnamedGroups(m, [learning]).length, 2, 'a voice still learning is not used, so it is still unnamed');
});

console.log(`\n${passed} passed`);
