// The voice rules with synthetic fingerprints and synthetic audio: storage, thresholds, smoothing, overlap,
// alignment to the transcript, merging with captions, clustering, and the speech tracker. These tests cover
// the plumbing and the rules. They say nothing about how accurate the speaker model is on real voices.
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

const V = await import('../src/voice/match.js');
const { VoiceTracker } = await import('../src/voice/tracker.js');

// deterministic "voices": a unit vector per person plus small noise per utterance
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const base = (k) => {
  seed = 1000 + k * 97;
  return V.normalize(Float32Array.from({ length: 256 }, rnd));
};
const BASES = Object.fromEntries([1, 2, 3, 9].map((k) => [k, base(k)]));
const near = (b, noise = 1.2) => V.normalize(Float32Array.from(b, (x) => x + (noise * rnd()) / 16));
const person = (id, name, k) => {
  const windows = Array.from({ length: 6 }, () => near(BASES[k]));
  return { id, name, centroid: V.pack(V.mean(windows)), windows: windows.map(V.pack) };
};
const amal = person('a', 'Amal Raj', 1);
const priya = person('p', 'Priya Nair', 2);
const people = [amal, priya];
const seg = (t0, who, noise = 1.2, len = 3) => ({ t0, t1: t0 + len, e: V.pack(near(BASES[who], noise)) });
const blend = (a, b, wa, wb) => V.normalize(Float32Array.from(BASES[a], (x, i) => x * wa + BASES[b][i] * wb));

await test('voice: fingerprints survive packing to one byte per number', () => {
  const v = near(BASES[1]);
  const back = V.unpack(V.pack(v));
  assert.ok(V.cosine(v, back) > 0.999);
  assert.ok(V.pack(v).length < 400);
});

await test('voice: the right person is named, a stranger is unknown', () => {
  assert.equal(V.classify(near(BASES[1]), people).name, 'Amal Raj');
  assert.equal(V.classify(near(BASES[2]), people).name, 'Priya Nair');
  const stranger = V.classify(near(BASES[9]), people);
  assert.equal(stranger.id, null);
  assert.match(stranger.why, /different/);
  assert.equal(V.classify(near(BASES[1]), []).id, null);
  assert.equal(V.classify(null, people).id, null);
});

await test('voice: overlapping speech (two voices mixed) becomes unknown, never a confident wrong name', () => {
  const r = V.classify(blend(1, 2, 1, 1), people);
  assert.equal(r.id, null, JSON.stringify({ score: r.score, margin: r.margin }));
});

await test('voice: a weak glitch between two pieces of the same person is smoothed, a strong change is kept', () => {
  const glitch = { t0: 6, t1: 9, e: V.pack(blend(2, 1, 0.55, 0.55)) };
  const segs = [seg(0, 1), seg(3, 1), glitch, { ...seg(9, 1), t0: 9, t1: 12 }, { ...seg(12, 1), t0: 12, t1: 15 }];
  assert.deepEqual(V.labelSegments(segs, people).map((s) => s.name), ['Amal Raj', 'Amal Raj', 'Amal Raj', 'Amal Raj', 'Amal Raj']);
  const real = [seg(0, 1), seg(3, 1), seg(6, 2), seg(9, 2), seg(12, 1)];
  assert.deepEqual(V.labelSegments(real, people).map((s) => s.name), ['Amal Raj', 'Amal Raj', 'Priya Nair', 'Priya Nair', 'Amal Raj']);
});

await test('voice: neighbours far apart in time do not vote for each other', () => {
  const weak = { t0: 100, t1: 103, e: V.pack(blend(2, 1, 0.55, 0.55)) };
  const out = V.labelSegments([seg(0, 1), seg(3, 1), weak, seg(200, 1)], people);
  assert.notEqual(out[2].name, 'Amal Raj');
});

await test('voice: transcript sentences are placed on the speech and take the voice that speaks them', () => {
  const labelled = V.labelSegments([seg(100, 1, 1, 4), seg(104, 1, 1, 4), seg(108, 2, 1, 4), seg(112, 2, 1, 4)], people);
  const passage = { t: 100, dur: 16, text: 'We will ship on Friday. The data sheet is ready. Okay, I will check the mapping file today. Good, thanks.' };
  const out = V.alignPassage(passage, labelled);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((o) => o.name), ['Amal Raj', 'Amal Raj', 'Priya Nair', 'Priya Nair']);
  assert.ok(out.every((o) => o.t >= 100 && o.t <= 116));
  assert.ok(out[0].t <= out[3].t);
});

await test('voice: a sentence that spans two voices is not given to one of them', () => {
  const labelled = V.labelSegments([seg(0, 1, 1, 4), seg(4, 2, 1, 4)], people);
  const out = V.alignPassage({ t: 0, dur: 8, text: 'One long sentence that runs across both speakers without any stop in the middle' }, labelled);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, null);
  assert.equal(out[0].mixed, true);
});

await test('voice: with no speech pieces the passage stays unlabelled, with nothing invented', () => {
  const out = V.alignPassage({ t: 0, dur: 100, text: 'Hello there. Nothing was heard.' }, []);
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.name === null && o.none));
});

await test('voice: captions are merged: agree keeps the name, disagree shows both, captions fill gaps', () => {
  const lines = [
    { t: 10, text: 'We agreed on Tuesday for the review meeting.', id: 'a', name: 'Amal Raj' },
    { t: 40, text: 'I think the risk is high for the upload.', id: 'p', name: 'Priya Nair' },
    { t: 80, text: 'Nobody knew this voice at all really.', id: null, name: null },
    { t: 120, text: 'Voice only line with no captions.', id: 'a', name: 'Amal Raj' },
  ];
  const caps = [{ t: 11, t2: 14, name: 'Amal' }, { t: 41, t2: 44, name: 'Ravi Kumar' }, { t: 82, t2: 85, name: 'Sita Menon' }];
  const m = V.mergeWithCaptions(lines, caps);
  assert.equal(m[0].source, 'voice+captions');
  assert.equal(V.labelText(m[0]), 'Amal Raj');
  assert.equal(m[1].source, 'conflict');
  assert.equal(V.labelText(m[1]), 'Priya Nair (captions say Ravi Kumar)');
  assert.equal(m[2].name, 'Sita Menon');
  assert.equal(m[2].source, 'captions');
  assert.equal(m[3].source, 'voice');
  assert.equal(V.labelText({ name: null }), 'Unknown speaker');
});

await test('voice: a whole meeting is labelled, lines of one speaker merge, the note-taker keeps their own mic lines', () => {
  const meeting = {
    voiceSegs: [seg(0, 1, 1, 4), seg(4, 1, 1, 4), seg(8, 2, 1, 4), seg(12, 2, 1, 4)],
    segments: [
      { t: 0, dur: 16, src: 'others', text: 'Good morning everyone. Let us begin the review. I have the numbers here. They look fine to me.' },
      { t: 6, dur: 2, src: 'me', text: 'Yes please go ahead.' },
    ],
  };
  const lines = V.labelTranscript(meeting, people, { myName: 'Shrawin' });
  assert.deepEqual(lines.map((l) => l.label), ['Amal Raj', 'Shrawin', 'Priya Nair']);
  assert.match(lines[0].text, /Good morning everyone\. Let us begin/);
  assert.equal(V.labelTranscript({ ...meeting, voiceSegs: [] }, people), null, 'nothing to label with');
  assert.equal(V.labelTranscript(meeting, [], {}), null, 'nobody enrolled');
  const heard = V.voicePresence(lines);
  assert.deepEqual(Object.keys(heard).sort(), ['Amal Raj', 'Priya Nair']);
  assert.equal(heard['Amal Raj'][0], 0);
});

await test('voice: unknown voices in a meeting are grouped, biggest first, with usable average fingerprints', () => {
  const segs = [];
  for (let i = 0; i < 8; i++) segs.push(seg(i * 4, 1, 1));
  for (let i = 0; i < 5; i++) segs.push(seg(40 + i * 4, 2, 1));
  for (let i = 0; i < 2; i++) segs.push(seg(70 + i * 4, 3, 1));
  const groups = V.clusterVoices(segs);
  assert.deepEqual(groups.map((g) => g.members.length), [8, 5, 2]);
  assert.ok(V.cosine(V.unpack(groups[0].centroid), BASES[1]) > 0.8);
});

// ---- the speech tracker, with synthetic blocks ----
const BLOCK = 2048;
const tone = (db, n = BLOCK) => Float32Array.from({ length: n }, (_, i) => Math.pow(10, db / 20) * Math.sin((2 * Math.PI * 440 * i) / 16000) * Math.SQRT2);
const run = (plan) => {
  const out = [];
  const t = new VoiceTracker((s) => out.push(s));
  for (const [secs, db] of plan) for (let i = 0; i < Math.round((secs * 16000) / BLOCK); i++) t.push(tone(db));
  t.flush();
  return out;
};

await test('voice tracker: finds pieces of speech between pauses and ignores quiet and brief sounds', () => {
  const out = run([[3, -60], [3, -25], [1, -60], [2.2, -25], [2, -60], [0.5, -25], [3, -60]]);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].t0 - 3) < 0.3 && Math.abs(out[0].t1 - 6) < 0.4, JSON.stringify([out[0].t0, out[0].t1]));
  assert.ok(out[1].t0 > 6.5 && out[1].t1 - out[1].t0 >= 1.5);
  assert.ok(out.every((s) => s.pcm.length === Math.round((s.t1 - s.t0) * 16000)));
});

await test('voice tracker: long speech is cut into pieces of at most 4 seconds, in order, without gaps', () => {
  const out = run([[1, -60], [11, -25], [1, -60]]);
  assert.ok(out.length >= 3 && out.every((s) => s.t1 - s.t0 <= 4.3), JSON.stringify(out.map((s) => [s.t0, s.t1])));
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t0 >= out[i - 1].t1 - 0.01);
});

await test('voice tracker: a noisy room does not turn into endless speech', () => {
  const out = run([[10, -45], [3, -25], [4, -45]]);
  assert.ok(out.length <= 2, `${out.length} pieces`);
  assert.ok(out.every((s) => s.t0 >= 9.5), 'only the loud part counts');
});

// ---- enrolment plumbing (the fingerprint here is fake: this tests the rules, not the voice model) ----
const E = await import('../src/voice/enrol.js');
const speechAudio = (secs) => {
  const parts = [];
  parts.push(tone(-60, 2048 * 4)); // a recording starts in a quiet moment
  for (let i = 0; i < secs; i += 3) parts.push(tone(-25, 2048 * 24), tone(-60, 2048 * 4));
  const out = new Float32Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

await test('enrolment: about 20 s of speech becomes an average plus a few samples, nothing else', async () => {
  const r = await E.buildPrint(speechAudio(21), async () => near(BASES[1]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.speechSec >= 12 && r.pieces >= 4);
  assert.ok(r.windows.length >= 1 && r.windows.length <= E.ENROL.maxWindows);
  assert.deepEqual(Object.keys(r).sort(), ['centroid', 'consistency', 'ok', 'pieces', 'speechSec', 'warn', 'windows']);
  assert.ok(V.cosine(V.unpack(r.centroid), BASES[1]) > 0.8);
});

await test('enrolment: too little speech or silence is refused with a plain reason', async () => {
  const r = await E.buildPrint(speechAudio(3), async () => near(BASES[1]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /seconds of clear speech/);
  const q = await E.buildPrint(new Float32Array(16000 * 20), async () => near(BASES[1]));
  assert.equal(q.ok, false);
});

await test('enrolment: a piece of someone else speaking is left out of the fingerprint', async () => {
  let n = 0;
  const r = await E.buildPrint(speechAudio(30), async () => (++n === 3 ? near(BASES[2]) : near(BASES[1])));
  assert.equal(r.ok, true);
  assert.ok(V.cosine(V.unpack(r.centroid), BASES[1]) > 0.8);
});

await test('enrolment: add, name clash, re-record and add-a-language keep one person per name', () => {
  const print = { centroid: amal.centroid, windows: amal.windows, speechSec: 20 };
  let list = E.upsertPerson([], { name: '  Amal   Raj ', lang: 'en', print });
  assert.equal(list[0].name, 'Amal Raj');
  assert.throws(() => E.upsertPerson(list, { name: 'amal raj', print }), /already a voice/);
  assert.throws(() => E.upsertPerson(list, { name: '  ', print }), /name/);
  const id = list[0].id;
  list = E.upsertPerson(list, { id, name: 'Amal Raj', lang: 'en', print: { ...print, centroid: priya.centroid } });
  assert.equal(list.length, 1);
  assert.equal(list[0].centroid, priya.centroid);
  list = E.addRecording(list, id, { lang: 'ml', print });
  assert.deepEqual(list[0].langs, ['en', 'ml']);
  assert.equal(list[0].secs, 40);
  assert.ok(list[0].windows.length > print.windows.length);
  assert.ok(!JSON.stringify(list).includes('pcm'), 'no audio field is ever stored');
});

const S = await import('../src/voice/share.js');

await test('sharing: exported voices carry fingerprints only, import validates, merges and never overwrites silently', () => {
  const text = S.exportVoices([{ id: 'a', ...amal, lang: 'en', secs: 20 }, { id: 'p', ...priya, lang: 'hi', langs: ['hi'], secs: 18 }]);
  assert.ok(!/pcm|audio|"id"/.test(text));
  const { people: got, problems } = S.parseImport(text);
  assert.equal(got.length, 2);
  assert.equal(problems.length, 0);
  assert.equal(got[1].langs[0], 'hi');
  const mine = E.upsertPerson([], { name: 'Amal Raj', lang: 'en', print: { centroid: priya.centroid, windows: [], speechSec: 5 } });
  const keep = S.mergeImport(mine, got);
  assert.deepEqual([keep.added, keep.skipped], [['Priya Nair'], ['Amal Raj']]);
  assert.equal(keep.list.find((p) => p.name === 'Amal Raj').centroid, priya.centroid);
  const rep = S.mergeImport(mine, got, { replace: true });
  assert.deepEqual(rep.replaced, ['Amal Raj']);
  assert.equal(rep.list.find((p) => p.name === 'Amal Raj').centroid, amal.centroid);
  assert.equal(rep.list.length, 2);
});

await test('sharing: files that are not valid voices are refused or trimmed, with a reason', () => {
  assert.match(S.parseImport('nope').problems[0], /could not be read/);
  assert.match(S.parseImport('{"a":1}').problems[0], /not a Debrief voices file/);
  assert.match(S.parseImport(JSON.stringify({ format: 'debrief-voices', model: 'other', people: [] })).problems[0], /different speaker model/);
  const bad = JSON.stringify({ format: 'debrief-voices', model: 'wespeaker-resnet34-lm', people: [{ name: 'X', centroid: 'AAAA' }, { name: '', centroid: amal.centroid }, { name: 'Ok', centroid: amal.centroid, windows: ['zz', amal.windows[0]] }] });
  const r = S.parseImport(bad);
  assert.deepEqual(r.people.map((p) => p.name), ['Ok']);
  assert.equal(r.people[0].windows.length, 1);
  assert.equal(r.problems.length, 2);
});

console.log(`\n${passed} passed`);
