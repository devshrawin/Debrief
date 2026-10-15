// Room mode: several people share the microphone. Synthetic fingerprints and text only: these tests show the labelling,
// prompts and bookkeeping are right, not that the voice model separates real people in a real room.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import * as V from '../src/voice/match.js';
import * as L from '../src/voice/learn.js';
import * as S from '../src/voice/samples.js';
import { formatTranscript, buildUserPrompt } from '../src/prompt.js';
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

let seed = 21;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const base = (k) => {
  seed = 300 + k * 53;
  return V.normalize(Float32Array.from({ length: 256 }, rnd));
};
const B = { 1: base(1), 2: base(2), 3: base(3) };
const near = (b) => V.normalize(Float32Array.from(b, (x) => x + (1.2 * rnd()) / 16));
const person = (id, name, k) => {
  const w = Array.from({ length: 6 }, () => near(B[k]));
  return { id, name, centroid: V.pack(V.mean(w)), windows: w.map(V.pack) };
};
const amal = person('a', 'Amal Raj', 1);
const priya = person('p', 'Priya Nair', 2);
const people = [amal, priya];
const piece = (t0, who, s) => ({ t0, t1: t0 + 4, e: V.pack(near(B[who])), ...(s ? { s } : {}) });

// A room: Amal speaks 0-16 s, Priya 16-32 s, all on the microphone (s: 'm'). A remote colleague (voice 3) is on the tab at 40 s.
const room = {
  id: 'r1',
  voiceSegs: [piece(0, 1, 'm'), piece(4, 1, 'm'), piece(8, 1, 'm'), piece(12, 1, 'm'), piece(16, 2, 'm'), piece(20, 2, 'm'), piece(24, 2, 'm'), piece(28, 2, 'm'), piece(40, 3), piece(44, 3)],
  segments: [
    { t: 0, dur: 32, src: 'me', text: 'We start with the budget. It is twelve percent over. Then the vendor. They can supply only half. I will call them today. Please send the sheet by Friday.' },
    { t: 40, dur: 8, src: 'others', text: 'From the remote side we agree with the plan.' },
  ],
};

await test('room: microphone passages are labelled by voice, not with the note-taker\'s name, and the tab stays separate', () => {
  const lines = V.labelTranscript(room, people, { myName: 'Shrawin', room: true });
  const mic = lines.filter((l) => l.src === 'me');
  assert.ok(mic.length >= 2, JSON.stringify(lines.map((l) => [l.src, l.label])));
  assert.ok(mic.every((l) => l.label !== 'Shrawin' && l.label !== 'Me'));
  assert.deepEqual([...new Set(mic.map((l) => l.label))].sort(), ['Amal Raj', 'Priya Nair']);
  assert.equal(mic[0].label, 'Amal Raj', 'the first speaker comes first');
  assert.equal(lines.find((l) => l.src === 'others').label, 'Unknown speaker', 'the remote voice was never enrolled');
});

await test('room: without room mode the microphone lines still carry the note-taker\'s name and ignore microphone pieces', () => {
  const lines = V.labelTranscript(room, people, { myName: 'Shrawin' });
  assert.deepEqual(lines.filter((l) => l.src === 'me').map((l) => l.label), ['Shrawin']);
  assert.ok(lines.filter((l) => l.src === 'others').every((l) => l.label === 'Unknown speaker'));
});

await test('room: people heard on the microphone count as present, the note-taker\'s own mic lines still do not', () => {
  const heard = V.voicePresence(V.labelTranscript(room, people, { myName: 'Shrawin', room: true }));
  assert.deepEqual(Object.keys(heard).sort(), ['Amal Raj', 'Priya Nair']);
  assert.deepEqual(Object.keys(V.voicePresence(V.labelTranscript(room, people, { myName: 'Shrawin' }))), []);
});

await test('room: captions are not merged into microphone lines', () => {
  const caps = [{ t: 0, t2: 30, name: 'Someone Else' }];
  const lines = V.labelTranscript(room, people, { captions: caps, myName: 'Shrawin', room: true });
  assert.ok(lines.filter((l) => l.src === 'me').every((l) => l.source !== 'conflict' && !/captions say/.test(l.label)));
});

await test('room: prompts say ROOM instead of ME, name speakers by voice, and warn the writer', () => {
  const plain = formatTranscript({ segments: room.segments }, 'Shrawin', { room: true });
  assert.match(plain, /ROOM:/);
  assert.doesNotMatch(plain, /ME \(Shrawin\)/);
  assert.match(formatTranscript({ segments: room.segments }, 'Shrawin', {}), /ME \(Shrawin\):/, 'unchanged outside room mode');
  const labeled = V.labelTranscript(room, people, { myName: 'Shrawin', room: true });
  const text = formatTranscript({ segments: room.segments }, 'Shrawin', { room: true, labeled });
  assert.match(text, /\] Amal Raj: /);
  assert.match(text, /\] Priya Nair: /);
  assert.doesNotMatch(text, /ME \(/);
  const p = buildUserPrompt({ title: 'T', startedAt: 0, segments: room.segments }, { myName: 'Shrawin' }, '', { room: true });
  assert.match(p, /recorded in a room/);
  assert.doesNotMatch(buildUserPrompt({ title: 'T', startedAt: 0, segments: room.segments }, { myName: 'Shrawin' }, '', {}), /recorded in a room/);
});

await test('room: Meet captions never teach voices from microphone pieces', () => {
  const m = { ...room, captions: [{ t: 0, t2: 40, name: 'Amal Raj', text: 'x' }] };
  assert.equal(L.evidence(m, {}).size, 0, 'the only pieces inside that caption came from the microphone');
});

await test('room: clips for microphone pieces use their own keys, and are found and cleaned up', async () => {
  assert.notEqual(S.pieceKey('m1', 4, 'm'), S.pieceKey('m1', 4));
  const meeting = { id: 'rm', voiceSegs: [], captions: [], segments: [] };
  for (let i = 0; i < 16; i++) {
    const t0 = i * 4;
    meeting.voiceSegs.push({ t0, t1: t0 + 3, e: V.pack(near(B[1])), s: 'm' });
    await S.putPiece(S.pieceKey('rm', t0, 'm'), S.toInt16(new Float32Array(3 * 16000).fill(0.1)));
  }
  const { list } = L.learnRecurring(meeting, []);
  assert.equal(list.length, 1);
  await saveSamples('rm', meeting, list);
  assert.ok(await S.hasSample(list[0].id), 'a clip is cut from microphone pieces');
  assert.equal(await S.getPiece(S.pieceKey('rm', 0, 'm')), undefined, 'waiting microphone audio is deleted');
});

await test('room switch: a meeting link means an online meeting, any other tab means a room, and the user can flip it', async () => {
  const R = await import('../src/room.js');
  for (const u of ['https://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij?authuser=0', 'https://app.zoom.us/wc/123/join', 'https://teams.microsoft.com/v2/', 'https://whereby.com/room', 'https://meet.jit.si/MyRoom']) assert.ok(R.isMeetingUrl(u), u);
  for (const u of ['https://meet.google.com/', 'https://meet.google.com/landing', 'https://www.google.com/', 'https://mail.google.com/mail', 'chrome://newtab/', 'about:blank', '', undefined]) assert.ok(!R.isMeetingUrl(u), String(u));
  assert.equal(R.roomFor('https://meet.google.com/abc-defg-hij'), false);
  assert.equal(R.roomFor('https://example.com/'), true);
  assert.equal(R.roomFor('https://meet.google.com/abc-defg-hij', true), true, 'the user said room');
  assert.equal(R.roomFor('https://example.com/', false), false, 'the user said online');
  assert.match(R.modeHint('https://meet.google.com/abc-defg-hij', false, false), /Google Meet detected/);
  assert.match(R.modeHint('https://example.com/', true, false), /not a meeting link/);
  assert.match(R.modeHint('https://example.com/', false, true), /Online meeting/);
});

console.log(`\n${passed} passed`);
