// The live page's logic (src/livelogic.js): merging what the background broadcasts with what is stored, grouping, the
// latency note, following the bottom, the page's state, and the provisional summary's prompt.
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

const L = await import('../src/livelogic.js');
const a = { t: 5, src: 'me', text: 'Let us start with the budget review.' };
const b = { t: 40, src: 'others', text: 'The budget is approved for the second quarter.' };
const c = { t: 90, src: 'others', text: 'Ravi will send the vendor contract on Friday.' };
const texts = (s) => s.rows.map((r) => r.text);

await test('broadcast first, then a re-read: no duplicates', () => {
  const s = new L.LiveStore();
  s.add('segment', [a]);
  const fresh = s.add('segment', [a, b]);
  assert.equal(s.rows.length, 2);
  assert.deepEqual(fresh.map((f) => f.row.text), [b.text]);
});

await test('re-read first, then a late broadcast of a line already stored: nothing added', () => {
  const s = new L.LiveStore();
  s.add('segment', [a, b]);
  assert.deepEqual(s.add('segment', [b]), []);
  assert.equal(s.rows.length, 2);
});

await test('out-of-order times end up in time order, with the index to insert at', () => {
  const s = new L.LiveStore();
  s.add('segment', [a, c]);
  const [f] = s.add('segment', [b]);
  assert.equal(f.index, 1);
  assert.deepEqual(s.rows.map((r) => r.t), [5, 40, 90]);
  // a batch handed over backwards is sorted too
  const s2 = new L.LiveStore();
  s2.add('segment', [c, a, b]);
  assert.deepEqual(s2.rows.map((r) => r.t), [5, 40, 90]);
});

await test('equal times keep arrival order', () => {
  const s = new L.LiveStore();
  s.add('segment', [{ t: 10, src: 'me', text: 'First thing said here.' }]);
  s.add('segment', [{ t: 10, src: 'others', text: 'Second thing said here.' }]);
  assert.deepEqual(texts(s), ['First thing said here.', 'Second thing said here.']);
});

await test('screen notes are interleaved by time and kept apart from speech', () => {
  const s = new L.LiveStore();
  s.add('segment', [a, c]);
  s.add('screen', [{ t: 60, text: 'Slide: Q2 budget table', presenter: 'Priya' }]);
  assert.deepEqual(s.rows.map((r) => r.kind), ['line', 'screen', 'line']);
  assert.equal(s.rows[1].presenter, 'Priya');
  assert.equal(s.lines().length, 2);
  // the same text as speech at the same time is not mistaken for the note
  assert.equal(s.add('segment', [{ t: 60, src: '', text: 'Slide: Q2 budget table' }]).length, 1);
});

await test('speaker labels: my name, Me, Others, the room, a named voice', () => {
  assert.equal(L.whoOf({ src: 'me' }, { myName: 'Amal' }), 'Amal');
  assert.equal(L.whoOf({ src: 'me' }), 'Me');
  assert.equal(L.whoOf({ src: 'me' }, { room: true, myName: 'Amal' }), 'Room');
  assert.equal(L.whoOf({ src: 'others' }), 'Others');
  assert.equal(L.whoOf({ src: 'others', spk: 'Priya' }), 'Priya');
  assert.equal(L.whoOf({ src: 'others', spk: 3 }), 'Others');
});

await test('lines that clean away to nothing are dropped and not retried', () => {
  const s = new L.LiveStore();
  const said = 'We will review the vendor contract and the payment schedule next week.';
  s.add('segment', [{ t: 3, src: 'others', text: said }]);
  const echo = { t: 30, src: 'others', text: said }; // the same sentence again from an overlapping piece
  assert.equal(s.add('segment', [echo]).length, 0);
  assert.equal(s.rows.length, 1);
  assert.deepEqual(s.add('segment', [echo]), []);
});

await test('grouping: consecutive lines of one speaker join, a screen note breaks the run', () => {
  const s = new L.LiveStore({ myName: 'Amal' });
  s.add('segment', [a, { t: 10, src: 'me', text: 'And then the hiring plan for the team.' }, b, { t: 50, src: 'others', text: 'We should also look at the vendor list.' }]);
  s.add('screen', [{ t: 45, text: 'Hiring tracker' }]);
  const g = L.groupLines(s.rows);
  assert.deepEqual(g.map((x) => [x.who, x.lines.length]), [['Amal', 2], ['Others', 1], ['', 1], ['Others', 1]]);
  assert.equal(L.continues(s.rows[0], s.rows[1]), true);
  assert.equal(L.continues(null, s.rows[0]), false);
});

await test('latency note for every provider and piece size', () => {
  assert.match(L.latencyNote({ sttProvider: 'gemini', sttGeminiChunk: 'standard' }).text, /about 2 minutes/);
  assert.match(L.latencyNote({ sttProvider: 'gemini', sttGeminiChunk: 'long' }).text, /about 4 minutes/);
  assert.match(L.latencyNote({ sttProvider: 'gemini', sttGeminiChunk: 'short' }).text, /about 40 seconds/);
  for (const p of ['sarvam', 'deepgram', 'openai']) assert.match(L.latencyNote({ sttProvider: p }).text, /about 25 seconds/);
});

await test('the faster-view hint shows only for Gemini standard or long', () => {
  const hint = (s) => L.latencyNote(s).hint;
  assert.match(hint({ sttProvider: 'gemini', sttGeminiChunk: 'standard' }), /choose short pieces in Settings → Recording/);
  assert.match(hint({ sttProvider: 'gemini', sttGeminiChunk: 'long' }), /free daily allowance/);
  assert.equal(hint({ sttProvider: 'gemini', sttGeminiChunk: 'short' }), '');
  assert.equal(hint({ sttProvider: 'sarvam', sttGeminiChunk: 'standard' }), '');
});

await test('follow only while at the bottom', () => {
  assert.equal(L.atBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), true);
  assert.equal(L.atBottom({ scrollTop: 860, clientHeight: 100, scrollHeight: 1000 }), true); // within the slack
  assert.equal(L.atBottom({ scrollTop: 500, clientHeight: 100, scrollHeight: 1000 }), false);
  assert.equal(L.atBottom({ scrollTop: 0, clientHeight: 100, scrollHeight: 90 }), true); // nothing to scroll
});

await test('state: broadcast, live-state, and the stored end time', () => {
  const R = L.reduceState;
  assert.equal(R({ id: 'm', broadcast: { recording: true, paused: false, startedAt: 1000 } }).phase, 'recording');
  assert.equal(R({ id: 'm', broadcast: { recording: true, paused: true, startedAt: 1000 } }).phase, 'paused');
  assert.equal(R({ id: 'm', broadcast: { recording: false, startedAt: 1000 } }).phase, 'ended');
  assert.equal(R({ id: 'm', rec: { recording: true, meetingId: 'm', startedAt: 7 } }).startedAt, 7);
  assert.equal(R({ id: 'm', rec: { recording: true, meetingId: 'm', paused: true } }).phase, 'paused');
  assert.equal(R({ id: 'm', rec: { recording: true, meetingId: 'other' }, meta: { startedAt: 1 } }).phase, 'ended');
  assert.equal(R({ id: 'm', rec: { recording: true, meetingId: 'm' }, meta: { startedAt: 1, endedAt: 9 } }).phase, 'ended', 'an end time wins');
  assert.equal(R({ id: 'm', meta: { startedAt: 1 } }).phase, 'unknown', 'no background, no end time: do not claim anything');
  assert.equal(R({ id: 'm', meta: { startedAt: 1 }, prev: { phase: 'recording', startedAt: 1 } }).phase, 'recording');
});

await test('chip text', () => {
  assert.equal(L.chipText({ phase: 'recording', startedAt: 0 }, 125000), 'Recording · 02:05');
  assert.equal(L.chipText({ phase: 'paused' }), 'Paused');
  assert.equal(L.chipText({ phase: 'ended' }), 'Ended');
});

const talk = (n, tag) => Array.from({ length: n }, (_, i) => ({ t: i * 10, src: i % 2 ? 'others' : 'me', text: `${tag} point ${i} we agreed the plan for the quarter and the owners of each item.` }));
const settings = { momLanguage: 'English', dictionary: '', sttProvider: 'gemini' };

await test('summary refuses under the word minimum', () => {
  const s = new L.LiveStore();
  s.add('segment', [a, b]);
  const p = L.summaryPrompt({ meeting: { id: 'm' }, rows: s.rows, settings });
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'Not enough has been said yet.');
  assert.ok(p.words < L.MIN_WORDS);
});

await test('summary prompt holds only this meeting, marked as unfinished, with the structured system prompt', () => {
  const s = new L.LiveStore({ myName: 'Amal' });
  s.add('segment', talk(8, 'ALPHA'));
  s.add('screen', [{ t: 5, text: 'SCREENNOTE should not be spoken text' }]);
  const p = L.summaryPrompt({ meeting: { id: 'm', title: 'Budget sync', startedAt: Date.UTC(2026, 9, 12) }, rows: s.rows, settings });
  assert.equal(p.ok, true);
  assert.match(p.system, /ONE JSON document/);
  assert.match(p.user, /still going on/);
  assert.match(p.user, /Budget sync/);
  assert.match(p.user, /ALPHA point 7/);
  assert.ok(!/SCREENNOTE/.test(p.user));
  assert.ok(!/OTHERMEETING/.test(p.user));
  assert.match(p.user, /<transcript>[\s\S]*<\/transcript>/);
});

await test('summary label and clock', () => {
  assert.equal(L.summaryAt({ phase: 'recording', startedAt: 0 }, 5, 65000), '01:05');
  assert.equal(L.summaryAt({ phase: 'ended' }, 125, 1e9), '02:05');
  assert.match(L.provisionalLabel('12:30'), /^Provisional — written at 12:30 from what was said so far\. The final minutes are written when the meeting ends\.$/);
});

console.log(`\n${passed} passed`);
