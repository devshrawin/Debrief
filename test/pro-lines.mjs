// Naming single transcript lines by hand, for one meeting only: the line key, the stored map, the transcript text the model
// reads (with and without voice recognition), and the people list the minutes know about.
import assert from 'node:assert/strict';
import * as L from '../src/linenames.js';
import { formatTranscript } from '../src/prompt.js';
import { nameCtxFor } from '../src/jobs.js';

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

await test('a line is found again by its source and start time; other sources and times are other lines', () => {
  assert.equal(L.lineKey({ src: 'others', t: 218.04 }), 'others@2180');
  assert.equal(L.lineKey({ src: 'me', t: 5 }), 'me@50');
  assert.equal(L.lineKey({ t: 5 }), 'others@50');
  assert.notEqual(L.lineKey({ src: 'others', t: 5 }), L.lineKey({ src: 'me', t: 5 }));
});

await test('set / change / remove a name on one line; the map given is never changed; junk is dropped', () => {
  const a = { src: 'others', t: 218 };
  const b = { src: 'others', t: 225 };
  const m0 = {};
  const m1 = L.setLineName(m0, a, '  Devashish   Banerjee ');
  assert.deepEqual(m0, {});
  assert.deepEqual(m1, { 'others@2180': 'Devashish Banerjee' });
  const m2 = L.setLineName(m1, b, 'Akash Behera');
  assert.equal(L.lineNameOf(m2, a), 'Devashish Banerjee');
  assert.equal(L.lineNameOf(m2, b), 'Akash Behera');
  assert.equal(L.lineNameOf(m2, { src: 'others', t: 300 }), '');
  assert.deepEqual(L.usedNames(m2), ['Devashish Banerjee', 'Akash Behera']);
  assert.deepEqual(L.setLineName(m2, a, ''), { 'others@2250': 'Akash Behera' });
  assert.deepEqual(L.cleanLineNames({ 'others@1': 'X', bad: 'Y', 'me@2': '  ', 'others@3': 5 }), { 'others@1': 'X', 'others@3': '5' });
  assert.deepEqual(L.cleanLineNames(null), {});
  assert.deepEqual(L.cleanLineNames([1, 2]), {});
});

await test('naming one line does not name the next unknown line (each is its own)', () => {
  const lines = [{ src: 'others', t: 10 }, { src: 'others', t: 20 }, { src: 'others', t: 30 }];
  const map = L.setLineName({}, lines[0], 'Devashish');
  assert.deepEqual(lines.map((l) => L.lineNameOf(map, l)), ['Devashish', '', '']);
});

const meeting = { id: 'm', segments: [{ t: 10, src: 'others', text: 'Actually today Satish sir is on leave.' }, { t: 40, src: 'others', text: 'Okay, no issue.' }, { t: 70, src: 'me', text: 'Thanks.' }] };

await test('without voice recognition: the model reads the name on that line, the others stay OTHERS', () => {
  const lineNames = L.setLineName({}, meeting.segments[0], 'Devashish Banerjee');
  const t = formatTranscript(meeting, 'Shrawin', { lineNames }).split('\n');
  assert.match(t[0], /^\[00:10\] Devashish Banerjee: Actually today/);
  assert.match(t[1], /^\[00:40\] OTHERS: Okay/);
  assert.match(t[2], /^\[01:10\] ME \(Shrawin\): Thanks/);
  assert.match(formatTranscript(meeting, 'Shrawin', {}).split('\n')[0], /OTHERS/);
});

await test('with voice recognition: the name wins over the guess, a wrong guess can be corrected, other lines keep their label', () => {
  const labeled = [
    { t: 218, src: 'others', label: 'Unknown speaker', name: null, text: 'Actually today uh Satish sir uh leave pe hain.' },
    { t: 224, src: 'others', label: 'Akash Behera', name: 'Akash Behera', text: 'Okay, okay, no issue.' },
    { t: 225, src: 'others', label: 'Unknown speaker', name: null, text: 'Uh nahi basically mere ko ye jaan na tha.' },
  ];
  let lineNames = L.setLineName({}, labeled[0], 'Devashish Banerjee');
  lineNames = L.setLineName(lineNames, labeled[1], 'Ankur Desai');
  const t = formatTranscript(meeting, '', { labeled, lineNames }).split('\n');
  assert.match(t[0], /^\[03:38\] Devashish Banerjee:/);
  assert.match(t[1], /^\[03:44\] Ankur Desai:/);
  assert.match(t[2], /^\[03:45\] Unknown speaker:/);
});

await test('the people the minutes know about include the names given to lines, once each', () => {
  const m = { ...meeting, attendees: ['Amal Samad'], lineNames: { 'others@100': 'Devashish Banerjee', 'others@400': 'Amal Samad', 'others@700': 'Safeena Mol' } };
  const ctx = nameCtxFor(m, { voices: [], voiceOn: false, dictionary: '' }, new Map());
  assert.deepEqual(ctx.attendees, ['Amal Samad', 'Devashish Banerjee', 'Safeena Mol']);
  assert.deepEqual(ctx.lineNames, m.lineNames);
  assert.deepEqual(nameCtxFor(meeting, { voices: [], dictionary: '' }, new Map()).lineNames, {});
});

console.log(`\n${passed} passed`);
