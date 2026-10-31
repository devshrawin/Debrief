// A transcript that came back too thin for the audio is noticed, read again in short parts, and reported when it stays thin;
// a stretch with no text is found in a finished transcript, and quiet or paused stretches are never reported as gaps.
import assert from 'node:assert/strict';
import { transcribePiece, judgePiece, splitRanges, readInParts, canSplit, findGaps, mergeGaps, gapLabel, gapMinutes, voicedSeconds, MIN_JUDGED_SEC } from '../src/coverage.js';
import { Chunker, SR } from '../src/chunker.js';
import { coverageMarkdown } from '../src/minutes.js';
import { transcriptGaps } from '../src/jobs.js';

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

const tone = (sec, amp = 0.08) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i / 7));
const quiet = (sec) => new Float32Array(Math.round(sec * SR));
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

await test('a piece with plenty of speech and almost no text is short; a normal answer, a short piece and silence are fine', () => {
  assert.equal(judgePiece('Okay.', 120).short, true);
  assert.equal(judgePiece('', 120).short, true);
  assert.equal(judgePiece('', 120).gap, true);
  assert.equal(judgePiece('x'.repeat(1500), 120).ok, true); // 12 characters per speech second
  assert.equal(judgePiece('', MIN_JUDGED_SEC - 1).ok, true, 'a few seconds of speech are not judged');
  assert.equal(judgePiece('', 0).ok, true, 'a silent piece is not a gap');
});

await test('between the floor and half of it a piece is short but not yet a gap', () => {
  const v = judgePiece('x'.repeat(250), 100); // 2.5 per second: below 3, above 1.5
  assert.equal(v.short, true);
  assert.equal(v.gap, false);
  assert.equal(v.expected, 300);
});

await test('speech seconds count only the loud blocks', () => {
  const blocks = [tone(1), quiet(1), tone(0.5)].flatMap((p) => {
    const out = [];
    for (let i = 0; i < p.length; i += 2048) out.push(p.subarray(i, Math.min(p.length, i + 2048)));
    return out;
  });
  assert.ok(Math.abs(voicedSeconds(blocks) - 1.5) < 0.2, String(voicedSeconds(blocks)));
});

await test('the chunker reports how much speech a piece holds, and how long a silent piece was', () => {
  const got = [];
  const skipped = [];
  const c = new Chunker('mix', (src, t, pcm, metas, info) => got.push({ t, sec: pcm.length / SR, info }), { minSec: 2, maxSec: 5, onSkip: (src, t, peak, dur) => skipped.push({ t, dur }) });
  const feed = (pcm) => {
    for (let i = 0; i < pcm.length; i += 2048) c.push(pcm.subarray(i, Math.min(pcm.length, i + 2048)));
  };
  feed(join(tone(3), quiet(1))); // a pause after 3 s speech: cut there
  c.flush();
  feed(quiet(6)); // 6 s of silence: skipped, and its length is reported
  c.flush();
  assert.ok(got.length >= 1);
  assert.ok(got[0].info.voicedSec > 2.5 && got[0].info.voicedSec <= got[0].sec, JSON.stringify(got[0]));
  assert.ok(skipped.length >= 1 && skipped.reduce((a, s) => a + s.dur, 0) >= 5, JSON.stringify(skipped));
});

await test('a long piece is cut into parts of about 45 s, at the quietest spot near each boundary', () => {
  const pcm = join(tone(40), quiet(0.3), tone(40), quiet(0.3), tone(40));
  const ranges = splitRanges(pcm, 45);
  assert.equal(ranges.length, 3);
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges.at(-1)[1], pcm.length);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1], 'no gap and no overlap');
  const cutAt = ranges[0][1] / SR;
  assert.ok(Math.abs(cutAt - 40.15) < 0.4, `cut at ${cutAt}, the pause is at 40-40.3 s`);
  assert.equal(splitRanges(tone(30), 45).length, 1);
  assert.equal(canSplit(tone(30)), false);
  assert.equal(canSplit(tone(150)), true);
});

await test('reading in parts asks once per part, skips silent parts, and joins the answers in order', async () => {
  const pcm = join(tone(50), quiet(50), tone(50));
  const asked = [];
  const r = await readInParts({
    pcm,
    encode: (p) => ({ sec: p.length / SR }),
    transcribeFn: async (wav) => (asked.push(wav.sec), `part${asked.length}`),
  });
  assert.equal(r.parts, asked.length);
  assert.ok(r.parts >= 2 && r.parts <= 3, String(r.parts));
  assert.match(r.text, /^part1 part2/);
  assert.ok(asked.every((s) => s <= 60));
});

await test('a failing part fails the whole read (the caller keeps what it already had)', async () => {
  await assert.rejects(readInParts({ pcm: tone(120), encode: (p) => p, transcribeFn: async () => { throw new Error('429'); } }), /429/);
});

await test('a gap of more than 75 s with no text is found; the time the text before it takes to say is not counted as a gap', () => {
  const segs = [{ t: 0, text: 'x'.repeat(90) }, { t: 10, text: 'short' }, { t: 214, text: 'back again' }];
  const g = findGaps(segs);
  assert.equal(g.length, 1);
  assert.ok(g[0].from >= 12 && g[0].from <= 20, JSON.stringify(g));
  assert.equal(g[0].to, 214);
  assert.deepEqual(findGaps([{ t: 0, text: 'x'.repeat(900) }, { t: 100, text: 'b' }]), [], '900 characters take 100 s to say: no gap');
});

await test('a piece that records where it came from (c, dur) covers exactly that stretch', () => {
  const segs = [{ t: 20, c: 0, dur: 150, text: 'one sentence' }, { t: 200, c: 170, dur: 150, text: 'next' }];
  assert.deepEqual(findGaps(segs, [], { minGap: 10 }), [{ from: 150, to: 200 }]);
  assert.deepEqual(findGaps(segs, [], { minGap: 60 }), []);
  // sentences of one piece start inside it and never create a gap
  assert.deepEqual(findGaps([{ t: 0, c: 0, dur: 150, text: 'a' }, { t: 140, c: 0, dur: 150, text: 'b' }, { t: 150, c: 150, dur: 100, text: 'c' }], [], { minGap: 5 }), []);
});

await test('pauses and silent pieces are not gaps; what is left of a gap beside them still is', () => {
  const segs = [{ t: 0, c: 0, dur: 20, text: 'a' }, { t: 400, c: 400, dur: 20, text: 'b' }];
  assert.deepEqual(findGaps(segs, [{ from: 20, to: 400 }]), []);
  assert.deepEqual(findGaps(segs, [{ from: 20, to: 100 }, { from: 300, to: 400 }]), [{ from: 100, to: 300 }]);
  assert.deepEqual(findGaps(segs, [{ from: 100, to: null }]), [{ from: 20, to: 100 }], 'a pause with no end runs to the end');
  assert.deepEqual(findGaps(segs, [{ from: 30, to: 60 }]), [{ from: 60, to: 400 }], 'the 10 s before a short pause is too short to report, the rest is a gap');
});

await test('gaps found while recording and in the transcript are one list; the minutes say them in words', () => {
  const merged = mergeGaps([{ t: 100, dur: 150 }], [{ from: 240, to: 300 }, { from: 1000, to: 1100 }]);
  assert.deepEqual(merged, [{ from: 100, to: 300 }, { from: 1000, to: 1100 }]);
  assert.equal(gapLabel({ from: 1247, to: 1461 }), '20:47–24:21');
  assert.equal(gapMinutes(merged), 5);
  const md = coverageMarkdown({ gaps: merged });
  assert.match(md, /Coverage warning/);
  assert.match(md, /01:40–05:00, 16:40–18:20/);
  assert.match(md, /about 5 min/);
  assert.equal(coverageMarkdown({}), '');
  assert.match(coverageMarkdown({ pendingCount: 1, pendingSec: 120, gaps: merged }), /could not be transcribed.*Also, no transcript/s);
});

await test('transcriptGaps reads the meeting: pauses and silences excuse a stretch', () => {
  const meeting = {
    segments: [{ t: 0, c: 0, dur: 100, text: 'a' }, { t: 600, c: 600, dur: 100, text: 'b' }],
    pauses: [{ from: 100, to: 300 }],
    silences: [{ t: 300, dur: 150 }],
    gaps: [{ t: 450, dur: 100 }],
  };
  assert.deepEqual(transcriptGaps(meeting), [{ from: 450, to: 600 }], 'the pause and the silence are excused; what remains up to the next text is a gap, with the one recorded inside it');
  assert.deepEqual(transcriptGaps({ segments: [] }), []);
  assert.deepEqual(transcriptGaps({}), []);
});

const speech = (sec) => tone(sec); // voiced all the way
const fake = (answers) => {
  const calls = [];
  return { calls, fn: async (wav) => (calls.push(wav.sec), typeof answers === 'function' ? answers(calls.length, wav) : answers[Math.min(calls.length - 1, answers.length - 1)]) };
};
const enc = (p) => ({ sec: p.length / SR });
const words = (n) => 'word '.repeat(n).trim();

await test('a piece with a full answer costs one request', async () => {
  const f = fake([words(300)]);
  const pcm = speech(120);
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 120, transcribeFn: f.fn, encode: enc });
  assert.equal(f.calls.length, 1);
  assert.equal(r.gap, false);
  assert.equal(r.text, words(300));
});

await test('a thin answer to a long piece is replaced by the answer for its parts', async () => {
  const notes = [];
  const f = fake((n) => (n === 1 ? 'Okay.' : words(120)));
  const pcm = speech(150);
  const budget = { left: 2 };
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: f.fn, encode: enc, budget, note: (n) => notes.push(n) });
  assert.ok(f.calls.length >= 4, `asked ${f.calls.length} times`); // the whole piece, then 3 parts of ~50 s
  assert.equal(f.calls[0], 150);
  assert.ok(f.calls.slice(1).every((s) => s < 60));
  assert.ok(r.text.length > 1000, String(r.text.length));
  assert.equal(r.gap, false);
  assert.equal(budget.left, 1);
  assert.ok(notes.some((n) => /looks incomplete/.test(n)) && notes.some((n) => /part\(s\)/.test(n)));
});

await test('still thin after the parts: the piece is reported as a gap and the longer answer is kept', async () => {
  const f = fake((n) => (n === 1 ? 'Okay.' : 'Yes.'));
  const pcm = speech(150);
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: f.fn, encode: enc });
  assert.equal(r.gap, true);
  assert.ok(r.text.startsWith('Yes.'), r.text); // 3 parts of "Yes." are longer than "Okay."
});

await test('a failing re-read keeps the first answer; only the quota for re-reads is spent', async () => {
  const notes = [];
  const f = fake((n) => {
    if (n === 1) return 'Okay, one thing.';
    throw new Error('Gemini HTTP 429');
  });
  const pcm = speech(150);
  const budget = { left: 1 };
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: f.fn, encode: enc, budget, note: (n) => notes.push(n) });
  assert.equal(r.text, 'Okay, one thing.');
  assert.equal(r.gap, true);
  assert.ok(notes.some((n) => /failed \(Gemini HTTP 429\)/.test(n)));
});

await test('the first request failing is the caller\'s to handle (the audio is kept for a retry)', async () => {
  const pcm = speech(150);
  await assert.rejects(transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: async () => { throw new Error('Gemini HTTP 400'); }, encode: enc }), /400/);
});

await test('when the allowance for re-reads is used up, a thin piece is only reported', async () => {
  const f = fake(['Okay.']);
  const pcm = speech(150);
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: f.fn, encode: enc, budget: { left: 0 } });
  assert.equal(f.calls.length, 1);
  assert.equal(r.gap, true);
});

await test('a short piece cannot be read in shorter parts: no extra request, reported only when far too thin', async () => {
  const f = fake(['']);
  const pcm = speech(28);
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 26, transcribeFn: f.fn, encode: enc });
  assert.equal(f.calls.length, 1);
  assert.equal(r.gap, true);
  const g = fake(['hello there']);
  const few = await transcribePiece({ pcm: speech(10), wav: enc(speech(10)), voicedSec: 8, transcribeFn: g.fn, encode: enc });
  assert.equal(few.gap, false, 'less than 20 s of speech is never judged');
});

await test('a piece with no speech (a quiet room) is never read again', async () => {
  const f = fake(['']);
  const pcm = quiet(150);
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 3, transcribeFn: f.fn, encode: enc });
  assert.equal(f.calls.length, 1);
  assert.equal(r.gap, false);
});

await test('two re-reads that find nothing more switch re-reading off for the rest of the recording (music, noise, a broken model)', async () => {
  const f = fake(['']);
  const budget = { left: 8 };
  const pcm = speech(150);
  for (let i = 0; i < 4; i++) await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: f.fn, encode: enc, budget });
  const first = f.calls.length;
  // piece 1 and piece 2: whole + 3 parts each (8 requests); pieces 3 and 4: one request each
  assert.equal(first, 4 + 4 + 1 + 1, String(first));
  assert.equal(budget.left, 0);
  const g = fake([words(200)]);
  const r = await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: g.fn, encode: enc, budget });
  assert.equal(g.calls.length, 1, 'a healthy piece is still one request');
  assert.equal(r.gap, false);
});

await test('a re-read that does help does not count against the recording', async () => {
  const budget = { left: 8 };
  const pcm = speech(150);
  for (let i = 0; i < 4; i++) {
    const f = fake((n) => (n === 1 ? 'Okay.' : words(120)));
    await transcribePiece({ pcm, wav: enc(pcm), voicedSec: 150, transcribeFn: f.fn, encode: enc, budget });
  }
  assert.equal(budget.left, 4);
  assert.equal(budget.fruitless || 0, 0);
});

console.log(`\n${passed} passed`);
