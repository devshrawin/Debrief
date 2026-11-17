// The recording notice in the meeting chat, the record reminder, presenting, screen notes and the live feed:
// the service worker (real src/background.js on a fake chrome API), the pill's decision rules, and the real pill script
// (src/pill.js, bundled) running in jsdom on fake Meet markup. Real Meet could not be inspected: markup here is guessed.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as esbuild from 'esbuild';

// the user's keyboard shortcut, as the browser reports it (read before the worker asks the first time)
globalThis.__shortcut = 'Ctrl+Shift+Y';
const { send, state } = await import('./bg-harness.mjs');
chrome.commands.getAll = async () => [{ name: 'toggle-fullscreen', shortcut: 'Alt+Shift+F' }, { name: 'toggle-recording', shortcut: globalThis.__shortcut }];
// what the worker broadcasts to a live page: recorded here; a test can make nobody listen (reject) or the call throw
const liveLog = [];
let liveMode = 'ok';
const realSend = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = (m) => {
  if (m?.target === 'live') {
    liveLog.push(m);
    if (liveMode === 'reject') return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    if (liveMode === 'throw') throw new Error('Extension context invalidated.');
    return undefined;
  }
  return realSend(m);
};
const { getMeeting } = await import('../src/store.js');
const { noticeController, nudgeController, presentingReporter, cleanTitle, TRANSIENT, RETRY_MS } = await import('../src/adapters/pillrules.js');

let passed = 0;
async function test(name, fn) {
  try {
    state.mem.local = {};
    state.mem.session = {};
    state.created.length = 0;
    state.notes.length = 0;
    state.offLog.length = 0;
    liveLog.length = 0;
    liveMode = 'ok';
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 22).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const OWN = { id: 'testid', url: 'chrome-extension://testid/popup.html' };
const OFFSCREEN = { id: 'testid', url: 'chrome-extension://testid/offscreen.html' };
const page = (tab) => ({ id: 'testid', tab: { id: tab }, url: 'https://meet.google.com/abc-defg-hij' });
const live = (extra = {}) => {
  state.mem.session.rec = { recording: true, meetingId: 'mt', tabId: 7, startedAt: Date.now() - 5000, mic: true, micOn: true, micWanted: true, meetMuted: null, ...extra };
  state.mem.local['meeting:mt'] = { id: 'mt', title: 'Secret board meeting', startedAt: Date.now() - 5000, endedAt: null, segments: [], errors: [], mom: '' };
  state.mem.local.meetingIds = ['mt'];
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- service worker

await test('every new handler exists; only the four page messages are open to a meeting page', async () => {
  live();
  for (const type of ['notice-result', 'presenting', 'nudge-dismiss', 'set-nudge']) assert.notEqual(await send({ type }, page(7)), 'NO-HANDLER', `${type} must be allowed from a page`);
  for (const type of ['screen-note', 'live-state']) {
    assert.equal(await send({ type, meetingId: 'mt', note: { t: 1, text: 'x' } }, page(7)), 'NO-HANDLER', `${type} must not be open to a page`);
    assert.notEqual(await send({ type, meetingId: 'mt', note: { t: 1, text: 'x' } }, OFFSCREEN), 'NO-HANDLER', `${type} from Debrief's own page`);
  }
});

await test('notice-result: the first result is kept in the debug list and META, a second is ignored, and the pill state says done', async () => {
  live();
  state.mem.local.settings = { consentNotice: true, consentText: 'Recorded by Debrief.' };
  let ps = await send({ type: 'pill-state' }, page(7));
  assert.deepEqual(ps.notice, { on: true, text: 'Recorded by Debrief.', done: false });
  assert.deepEqual(await send({ type: 'notice-result', ok: false, posted: false, why: 'chat is turned off in this meeting' }, page(7)), { ok: true, first: true });
  assert.equal((await send({ type: 'notice-result', ok: true, posted: true }, page(7))).first, false);
  const m = await getMeeting('mt');
  assert.equal(m.notice.ok, false);
  assert.equal(m.notice.posted, false);
  assert.equal(m.notice.why, 'chat is turned off in this meeting');
  assert.ok(m.notice.at > 0);
  assert.deepEqual(m.debug, ['chat notice: failed (chat is turned off in this meeting)']);
  ps = await send({ type: 'pill-state' }, page(7));
  assert.equal(ps.notice.done, true);
});

await test('notice-result: only from the recorded tab, only while recording, only well-formed', async () => {
  live();
  assert.deepEqual(await send({ type: 'notice-result', ok: true, posted: true }, page(99)), { ok: false });
  assert.deepEqual(await send({ type: 'notice-result', ok: 'yes' }, page(7)), { ok: false });
  assert.deepEqual(await send({ type: 'notice-result', ok: true, why: { x: 1 } }, page(7)), { ok: false });
  assert.deepEqual(await send({ type: 'notice-result', ok: true }, OWN), { ok: false }, 'no tab: not a page of the recorded call');
  assert.equal((await getMeeting('mt')).notice, undefined);
  const long = 'x'.repeat(500);
  await send({ type: 'notice-result', ok: false, why: long }, page(7));
  assert.equal((await getMeeting('mt')).notice.why.length, 120);
  state.mem.session.rec.recording = false;
  assert.deepEqual(await send({ type: 'notice-result', ok: true, posted: true }, page(7)), { ok: false });
});

await test('pill-state: notice is off by default, and the nudge carries only what matching needs (no keys, no prompt text)', async () => {
  live();
  state.mem.local.settings = { geminiKey: 'SECRET-KEY', meetingTypes: [{ id: 'daily', name: 'Daily', match: 'standup', code: 'abc-defg-hij', extra: 'SECRET-PROMPT', columns: ['A'], updates: true }] };
  const ps = await send({ type: 'pill-state' }, page(7));
  assert.equal(ps.notice.on, false);
  assert.equal(ps.shortcut, 'Ctrl+Shift+Y');
  assert.deepEqual(ps.nudge, { on: true, skipOneOnOne: true, meetingTypes: [{ id: 'daily', name: 'Daily', match: 'standup', code: 'abc-defg-hij' }], dismissed: [] });
  assert.doesNotMatch(JSON.stringify(ps), /SECRET/);
});

await test('set-nudge flips only recordNudge; anything but a boolean is refused; types are not sent while it is off', async () => {
  state.mem.local.settings = { myName: 'Me', meetingTypes: [{ id: 'd', name: 'D', match: 'x' }] };
  assert.deepEqual(await send({ type: 'set-nudge', on: 'no' }, page(7)), { ok: false });
  assert.deepEqual(await send({ type: 'set-nudge', on: false }, page(7)), { ok: true });
  assert.deepEqual(state.mem.local.settings, { myName: 'Me', meetingTypes: [{ id: 'd', name: 'D', match: 'x' }], recordNudge: false });
  const ps = await send({ type: 'pill-state' }, page(7));
  assert.equal(ps.nudge.on, false);
  assert.deepEqual(ps.nudge.meetingTypes, []);
});

await test('nudge-dismiss: kept in the browser session, once each, the last 50 only, and shown to the pill', async () => {
  assert.deepEqual(await send({ type: 'nudge-dismiss', key: 'meet:aaa-bbbb-ccc' }, page(7)), { ok: true });
  await send({ type: 'nudge-dismiss', key: 'meet:aaa-bbbb-ccc' }, page(7));
  assert.deepEqual(state.mem.session.nudgeDismissed, ['meet:aaa-bbbb-ccc']);
  assert.equal(state.mem.local.nudgeDismissed, undefined, 'not kept across a browser restart');
  await Promise.all(Array.from({ length: 60 }, (_, i) => send({ type: 'nudge-dismiss', key: `k${i}` }, page(7))));
  const kept = state.mem.session.nudgeDismissed;
  assert.equal(kept.length, 50);
  assert.ok(!kept.includes('meet:aaa-bbbb-ccc') && kept.includes('k59'));
  for (const key of [undefined, '', 5, 'x'.repeat(201), { a: 1 }]) assert.deepEqual(await send({ type: 'nudge-dismiss', key }, page(7)), { ok: false });
  assert.equal(state.mem.session.nudgeDismissed.length, 50);
  assert.equal((await send({ type: 'pill-state' }, page(7))).nudge.dismissed.length, 50);
});

await test('nudge notification: once per call, no meeting title or address, the real shortcut, and never when reminders are off or recording', async () => {
  const key = 'title:secret board meeting:2026-01-01';
  assert.deepEqual(await send({ type: 'nudge-dismiss', key, notified: true }, page(7)), { ok: true, notified: true });
  assert.deepEqual(await send({ type: 'nudge-dismiss', key, notified: true }, page(7)), { ok: true, notified: false });
  assert.equal(state.notes.length, 1);
  const n = state.notes[0];
  assert.equal(n.title, 'Debrief: record this meeting?');
  assert.equal(n.message, 'A call that matches one of your meeting types is on. Click the Debrief button or press Ctrl+Shift+Y to record.');
  assert.doesNotMatch(JSON.stringify(n), /secret|board|meet\.google|abc-defg/i);
  assert.equal(state.mem.session.nudgeDismissed, undefined, 'a notification is not a dismissal');
  state.mem.local.settings = { recordNudge: false };
  assert.equal((await send({ type: 'nudge-dismiss', key: 'other', notified: true }, page(7))).notified, false);
  state.mem.local.settings = {};
  live();
  assert.equal((await send({ type: 'nudge-dismiss', key: 'other2', notified: true }, page(7))).notified, false);
  assert.equal(state.notes.length, 1);
});

await test('presenting: relayed to the recorder only for the recording tab, You becomes the user\'s name, bad input is dropped', async () => {
  live();
  state.mem.local.settings = { myName: 'Asha' };
  const relayed = () => state.offLog.filter((m) => m.type === 'presenting');
  assert.deepEqual(await send({ target: 'bg', type: 'presenting', on: true, name: 'Priya Nair' }, page(7)), { ok: true });
  assert.deepEqual(relayed(), [{ target: 'offscreen', type: 'presenting', on: true, name: 'Priya Nair' }]);
  await send({ type: 'presenting', on: true, name: 'You' }, page(7));
  assert.equal(relayed().at(-1).name, 'Asha');
  await send({ type: 'presenting', on: false, name: 'Priya Nair' }, page(7));
  assert.deepEqual(relayed().at(-1), { target: 'offscreen', type: 'presenting', on: false, name: null });
  const n = relayed().length;
  assert.deepEqual(await send({ type: 'presenting', on: true, name: 'Eve' }, page(99)), { ok: false }, 'another tab');
  assert.deepEqual(await send({ type: 'presenting', on: true, name: 'Eve' }, OWN), { ok: false });
  assert.deepEqual(await send({ type: 'presenting', on: 'yes' }, page(7)), { ok: false });
  assert.deepEqual(await send({ type: 'presenting', on: true, name: 'x'.repeat(61) }, page(7)), { ok: false });
  assert.deepEqual(await send({ type: 'presenting', on: true, name: { a: 1 } }, page(7)), { ok: false });
  assert.equal(relayed().length, n);
  state.mem.session.rec.recording = false;
  await send({ type: 'presenting', on: true, name: 'Eve' }, page(7));
  assert.equal(relayed().length, n, 'nothing is relayed when no recording is running');
  state.mem.session.rec = { recording: true, stopping: true, meetingId: 'mt', tabId: 7 };
  await send({ type: 'presenting', on: true, name: 'Eve' }, page(7));
  assert.equal(relayed().length, n);
});

await test('screen-note: the recorder stores notes in the meeting; bad notes are refused; 400 at most', async () => {
  live();
  assert.deepEqual(await send({ type: 'screen-note', meetingId: 'mt', note: { t: 12.5, text: 'A slide titled Q3 plan', presenter: 'Priya' } }, OFFSCREEN), { ok: true });
  assert.deepEqual(await send({ type: 'screen-note', meetingId: 'mt', note: { t: 0, text: 'x', presenter: null, extra: 'dropped' } }, OFFSCREEN), { ok: true });
  assert.deepEqual((await getMeeting('mt')).screens, [{ t: 12.5, text: 'A slide titled Q3 plan', presenter: 'Priya' }, { t: 0, text: 'x', presenter: null }]);
  const bad = [
    { t: -1, text: 'x' },
    { t: NaN, text: 'x' },
    { t: '5', text: 'x' },
    { t: 1, text: '' },
    { t: 1, text: '   ' },
    { t: 1, text: 'y'.repeat(601) },
    { t: 1, text: 5 },
    { t: 1, text: 'x', presenter: 'p'.repeat(61) },
    { t: 1, text: 'x', presenter: 7 },
    null,
    'text',
  ];
  for (const note of bad) assert.deepEqual(await send({ type: 'screen-note', meetingId: 'mt', note }, OFFSCREEN), { ok: false }, JSON.stringify(note));
  assert.deepEqual(await send({ type: 'screen-note', meetingId: 'nope', note: { t: 1, text: 'x' } }, OFFSCREEN), { ok: false }, 'unknown meeting');
  assert.deepEqual(await send({ type: 'screen-note', note: { t: 1, text: 'x' } }, OFFSCREEN), { ok: false });
  assert.equal((await getMeeting('mt')).screens.length, 2);
  assert.ok((await send({ type: 'screen-note', meetingId: 'mt', note: { t: 1, text: 'y'.repeat(600) } }, OFFSCREEN)).ok, '600 characters is allowed');
  live(); // a fresh meeting record, then 400 notes already in it
  state.mem.local['meeting:mt'].screens = Array.from({ length: 400 }, (_, i) => ({ t: i, text: `n${i}`, presenter: null }));
  liveLog.length = 0;
  assert.deepEqual(await send({ type: 'screen-note', meetingId: 'mt', note: { t: 999, text: 'one too many' } }, OFFSCREEN), { ok: false });
  assert.equal((await getMeeting('mt')).screens.length, 400);
  assert.equal(liveLog.length, 0, 'a note that was not stored is not shown live');
});

await test('live feed: segments and screen notes are broadcast; states on pause and stop; nobody listening never breaks anything', async () => {
  live();
  await send({ type: 'segment', meetingId: 'mt', seg: { t: 1, src: 'others', text: 'hello' } }, OFFSCREEN);
  await send({ type: 'screen-note', meetingId: 'mt', note: { t: 3, text: 'A chart', presenter: 'Priya' } }, OFFSCREEN);
  assert.deepEqual(liveLog[0], { target: 'live', type: 'live', meetingId: 'mt', kind: 'segment', item: { t: 1, src: 'others', text: 'hello' } });
  assert.deepEqual(liveLog[1], { target: 'live', type: 'live', meetingId: 'mt', kind: 'screen', item: { t: 3, text: 'A chart', presenter: 'Priya' } });
  liveLog.length = 0;
  await send({ type: 'pause', on: true }, OWN);
  await send({ type: 'pause', on: false }, OWN);
  assert.deepEqual(liveLog.map((m) => [m.kind, m.item.recording, m.item.paused]), [['state', true, true], ['state', true, false]]);
  assert.equal(typeof liveLog[0].item.startedAt, 'number');
  liveLog.length = 0;
  await send({ type: 'stop' }, OWN);
  assert.deepEqual(liveLog.map((m) => [m.kind, m.meetingId, m.item.recording]), [['state', 'mt', false]]);
  // nobody is listening: the call is rejected, or throws at once
  for (const mode of ['reject', 'throw']) {
    liveMode = mode;
    live();
    assert.deepEqual(await send({ type: 'segment', meetingId: 'mt', seg: { t: 2, src: 'me', text: 'hi' } }, OFFSCREEN), { ok: true });
    assert.deepEqual(await send({ type: 'screen-note', meetingId: 'mt', note: { t: 4, text: 'B' } }, OFFSCREEN), { ok: true });
    assert.equal((await send({ type: 'pause', on: true }, OWN)).paused, true);
    await send({ type: 'pause', on: false }, OWN);
  }
  await wait(20); // an unhandled rejection would have ended the process by now
});

await test('live feed: starting a recording announces it, and live-state tells a page which meeting is being recorded', async () => {
  state.mem.local.settings = { sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'm' };
  assert.deepEqual(await send({ type: 'live-state' }, OWN), { ok: true, rec: { recording: false }, meetingId: null });
  const r = await send({ type: 'start', streamId: 's', tabId: 7, title: 'Meet - Sync - Google Meet', url: 'https://meet.google.com/abc-defg-hij' }, OWN);
  assert.equal(r.ok, true);
  const id = state.mem.session.rec.meetingId;
  const st = liveLog.find((m) => m.kind === 'state');
  assert.equal(st.meetingId, id);
  assert.equal(st.item.recording, true);
  assert.equal(st.item.paused, false);
  assert.equal(typeof st.item.startedAt, 'number');
  const ls = await send({ type: 'live-state' }, OWN);
  assert.equal(ls.ok, true);
  assert.equal(ls.meetingId, id);
  assert.equal(ls.rec.recording, true);
  await send({ type: 'stop' }, OWN);
  assert.equal((await send({ type: 'live-state' }, OWN)).meetingId, null);
});

await test('store op listMeetingMetas for the offscreen job runner: newest first, counts, optional ids', async () => {
  const mk = (id, at, segs) => ({ id, title: id, startedAt: at, endedAt: at + 1, segments: Array.from({ length: segs }, (_, i) => ({ t: i, text: 'x' })), errors: [], mom: '' });
  state.mem.local['meeting:a'] = mk('a', 1000, 3);
  state.mem.local['meeting:b'] = mk('b', 2000, 1);
  state.mem.local.meetingIds = ['a', 'b'];
  const all = await send({ type: 'store', op: 'listMeetingMetas' }, OFFSCREEN);
  assert.equal(all.ok, true);
  assert.deepEqual(all.value.map((m) => m.id), ['b', 'a']);
  assert.equal(all.value[1].counts.segments, 3);
  const some = await send({ type: 'store', op: 'listMeetingMetas', opts: { ids: ['a'], counts: [] } }, OFFSCREEN);
  assert.deepEqual(some.value.map((m) => m.id), ['a']);
  assert.equal(some.value[0].segments, undefined, 'no transcript in a META list');
  const one = await send({ type: 'store', op: 'getMeetingMeta', id: 'a', opts: { counts: ['segments'] } }, OFFSCREEN);
  assert.equal(one.value.counts.segments, 3, 'opts are passed through');
  assert.deepEqual(Object.keys((await send({ type: 'store', op: 'getMeetingMeta', id: 'a', opts: { counts: [] } }, OFFSCREEN)).value.counts), []);
  assert.equal(await send({ type: 'store', op: 'listMeetingMetas' }, page(7)), 'NO-HANDLER');
});

// ---------------------------------------------------------------- the pill's rules

const NOTICE = { on: true, text: 'Recorded by Debrief.', done: false };
const base = (o = {}) => ({ now: 1000, recKey: 'm1', adapterId: 'meet', room: false, paused: false, inCall: true, notice: NOTICE, ...o });

await test('notice rules: one attempt once the page is in the call; success is reported and never repeated', () => {
  const c = noticeController();
  assert.equal(c.begin(base({ inCall: false })), false, 'not before the call is joined');
  assert.equal(c.begin(base()), true);
  assert.equal(c.begin(base()), false, 'one in flight at a time');
  const out = c.finish({ ok: true, posted: true }, 1000);
  assert.deepEqual(out, { report: { ok: true, posted: true, why: '' }, alert: null, retry: false });
  assert.equal(c.begin(base({ now: 99999 })), false);
});

await test('notice rules: a transient failure is tried once more after 20 s, reported only at the end; the alert says what to do', () => {
  const c = noticeController();
  for (const why of TRANSIENT) {
    const k = noticeController();
    assert.equal(k.begin(base()), true);
    assert.deepEqual(k.finish({ ok: false, why }, 1000), { report: null, alert: null, retry: true });
    assert.equal(k.begin(base({ now: 1000 + RETRY_MS - 1 })), false, 'not before 20 s');
    assert.equal(k.begin(base({ now: 1000 + RETRY_MS })), true);
    const out = k.finish({ ok: false, why }, 21000);
    assert.equal(out.report.ok, false);
    assert.equal(out.report.why, why);
    assert.equal(out.alert, `Debrief could not post the recording notice in the chat (${why}). Please tell people yourself.`);
    assert.equal(k.begin(base({ now: 10 ** 9 })), false, 'only one retry');
  }
  // a retry that works
  assert.equal(c.begin(base()), true);
  c.finish({ ok: false, why: 'could not find the chat box' }, 1000);
  assert.equal(c.begin(base({ now: 22000 })), true);
  assert.deepEqual(c.finish({ ok: true, posted: true }, 22000).report, { ok: true, posted: true, why: '' });
});

await test('notice rules: permanent reasons are never retried; "already there" counts as done', () => {
  for (const why of ['chat is turned off in this meeting', 'you have an unsent chat message', 'could not find the chat button', 'not in a call']) {
    const c = noticeController();
    assert.equal(c.begin(base()), true);
    const out = c.finish({ ok: false, why }, 1000);
    assert.equal(out.retry, false);
    assert.equal(out.report.why, why);
    assert.match(out.alert, /Please tell people yourself/);
    assert.equal(c.begin(base({ now: 10 ** 9 })), false, why);
  }
  const c = noticeController();
  c.begin(base());
  assert.deepEqual(c.finish({ ok: true, posted: false, why: 'already there' }, 1), { report: { ok: true, posted: false, why: 'already there' }, alert: null, retry: false });
});

await test('notice rules: never in room mode, never while paused (and it waits), never on another meeting app, never when done or off', () => {
  assert.equal(noticeController().begin(base({ room: true })), false);
  assert.equal(noticeController().begin(base({ adapterId: 'generic' })), false);
  assert.equal(noticeController().begin(base({ notice: { ...NOTICE, done: true } })), false);
  assert.equal(noticeController().begin(base({ notice: { ...NOTICE, on: false } })), false);
  assert.equal(noticeController().begin(base({ notice: { ...NOTICE, text: '' } })), false);
  assert.equal(noticeController().begin(base({ notice: undefined })), false);
  assert.equal(noticeController().begin(base({ recKey: null })), false, 'not recording this tab');
  const c = noticeController();
  assert.equal(c.begin(base({ paused: true })), false);
  assert.equal(c.begin(base({ paused: false })), true, 'posted once the recording continues');
  // a paused retry waits for the recording to continue
  c.finish({ ok: false, why: 'the message did not send' }, 1000);
  assert.equal(c.begin(base({ now: 30000, paused: true })), false);
  assert.equal(c.begin(base({ now: 31000 })), true);
});

await test('notice rules: a new recording gets its own attempt', () => {
  const c = noticeController();
  c.begin(base());
  c.finish({ ok: true, posted: true }, 1);
  assert.equal(c.begin(base({ recKey: 'm2' })), true);
});

const types = [{ id: 'daily', name: 'Daily standup', match: 'standup', code: '' }];
const cfg = (o = {}) => ({ on: true, skipOneOnOne: true, meetingTypes: types, dismissed: [], ...o });
const nudgeIn = (o = {}) => ({ now: 100000, recording: false, inCall: true, cfg: cfg(), title: 'Daily standup - Google Meet', url: 'https://meet.google.com/abc-defg-hij', participants: ['A', 'B', 'C'], shortcut: 'Ctrl+Shift+Y', ...o });

await test('nudge rules: the card appears once for a matching call, with the real shortcut, and goes when recording starts or the call ends', () => {
  const c = nudgeController();
  const a = c.step(nudgeIn());
  assert.equal(a.key, 'meet:abc-defg-hij');
  assert.equal(a.text, 'This looks like your "Daily standup". Press Ctrl+Shift+Y or click the Debrief button to record it.');
  assert.deepEqual(c.step(nudgeIn()), a, 'stays up while nothing changes');
  assert.equal(c.step(nudgeIn({ recording: true })), null, 'recording started');
  assert.equal(c.step(nudgeIn()), null, 'and does not come back after the recording stops: once per call');
  assert.equal(c.step(nudgeIn({ inCall: false })), null);
  assert.equal(c.step(nudgeIn()), null, 'the same call joined again is the same call');
  assert.ok(nudgeController().step(nudgeIn({ url: 'https://meet.google.com/zzz-yyyy-xxx' })), 'another call asks again');
});

await test('nudge rules: Not now dismisses for that call; a stored dismissal (page reload) keeps it away; no match, off, one-on-one say nothing', () => {
  const c = nudgeController();
  const a = c.step(nudgeIn());
  c.dismiss(a.key);
  assert.equal(c.step(nudgeIn()), null);
  assert.equal(nudgeController().step(nudgeIn({ cfg: cfg({ dismissed: ['meet:abc-defg-hij'] }) })), null, 'stored in the browser session');
  assert.equal(nudgeController().step(nudgeIn({ title: 'Lunch plans' })), null, 'no meeting type matches');
  assert.equal(nudgeController().step(nudgeIn({ cfg: cfg({ on: false }) })), null);
  assert.equal(nudgeController().step(nudgeIn({ cfg: undefined })), null);
  assert.equal(nudgeController().step(nudgeIn({ participants: ['A', 'B'] })), null, 'one-on-one');
  assert.ok(nudgeController().step(nudgeIn({ participants: ['A', 'B'], cfg: cfg({ skipOneOnOne: false }) })));
  // a list of people not read yet: wait 20 s after joining
  const w = nudgeController();
  assert.equal(w.step(nudgeIn({ participants: [], now: 100000 })), null);
  assert.equal(w.step(nudgeIn({ participants: [], now: 110000 })), null);
  assert.ok(w.step(nudgeIn({ participants: [], now: 120001 })));
  assert.equal(cleanTitle('Meet - Daily standup'), 'Daily standup');
  assert.equal(cleanTitle(''), 'Meeting');
});

await test('presenting reporter: sends on change and once after a recording starts, nothing when it cannot tell or nothing changed', () => {
  const r = presentingReporter();
  assert.equal(r.step(null, { on: true, name: 'P' }), null, 'not recording');
  assert.equal(r.step('m1', null), null, 'cannot tell');
  assert.deepEqual(r.step('m1', { on: false, name: null }), { on: false, name: null }, 'once after the start');
  assert.equal(r.step('m1', { on: false, name: null }), null);
  assert.deepEqual(r.step('m1', { on: true, name: 'Priya' }), { on: true, name: 'Priya' });
  assert.equal(r.step('m1', { on: true, name: 'Priya' }), null);
  assert.deepEqual(r.step('m1', { on: true, name: 'Amal' }), { on: true, name: 'Amal' });
  assert.deepEqual(r.step('m1', { on: false, name: 'Amal' }), { on: false, name: null });
  assert.equal(r.step(null, null), null);
  assert.deepEqual(r.step('m2', { on: false, name: null }), { on: false, name: null }, 'a new recording gets its own first report');
});

// ---------------------------------------------------------------- the real pill script in jsdom

const bundle = (await esbuild.build({ entryPoints: [new URL('../src/pill.js', import.meta.url).pathname], bundle: true, format: 'iife', write: false, logLevel: 'silent' })).outputFiles[0].text;

// Fake Meet: call controls, a chat button that opens a panel with a box and a send button, optional tiles and presenting banner.
function fakePage({ url = 'https://meet.google.com/abc-defg-hij', title = 'Daily standup - Google Meet', people = 3, chatOff = false, generic = false, visible = true, S }) {
  const html = generic
    ? '<button aria-label="Mute"></button><button>Leave</button>'
    : `<button aria-label="Leave call"></button><button data-is-muted="false" aria-label="Turn off microphone"></button>
       <button id="chatbtn" aria-label="Chat with everyone" aria-pressed="false"></button><div id="slot"></div><div id="banner"></div>
       ${Array.from({ length: people }, (_, i) => `<div data-participant-id="p${i}"><div>Person Number${'abc'[i]}</div></div>`).join('')}`;
  const dom = new JSDOM(`<!doctype html><title>${title}</title><body>${html}</body>`, { url, pretendToBeVisual: visible, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const doc = window.document;
  const sent = [];
  const chat = [];
  const btn = doc.getElementById('chatbtn');
  btn?.addEventListener('click', () => {
    const open = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!open));
    const slot = doc.getElementById('slot');
    if (open) return void (slot.innerHTML = '');
    slot.innerHTML = `<div role="complementary" aria-label="In-call messages"><div id="log"></div>${chatOff ? '<div>Chat is turned off by the host</div>' : '<textarea aria-label="Send a message"></textarea><button aria-label="Send a message" disabled></button>'}</div>`;
    const box = slot.querySelector('textarea');
    const sb = slot.querySelector('button');
    if (!box) return;
    box.addEventListener('input', () => (sb.disabled = false));
    sb.addEventListener('click', () => {
      chat.push(box.value);
      const m = doc.createElement('div');
      m.textContent = box.value;
      doc.getElementById('log').appendChild(m);
      box.value = '';
    });
  });
  window.chrome = {
    runtime: {
      id: 'testid',
      onMessage: { addListener() {} },
      async sendMessage(m) {
        if (m.type === 'whoami') return { ok: true, tabId: 7 };
        if (m.type === 'pill-state') return JSON.parse(JSON.stringify(S));
        sent.push(JSON.parse(JSON.stringify(m))); // a copy made here: objects of the jsdom window have another prototype
        return { ok: true };
      },
    },
  };
  window.eval(bundle);
  const root = () => doc.querySelector('[data-debrief]')?.__debriefRoot;
  const card = () => {
    const c = root()?.querySelector('.alertbox');
    return c && !c.classList.contains('hidden') ? c : null;
  };
  return { window, doc, sent, chat, card, host: () => doc.querySelector('[data-debrief]'), root, close: () => window.close() };
}
const recState = (o = {}) => ({ recording: true, meetingId: 'm1', tabId: 7, startedAt: Date.now() - 3000, mic: true, micOn: true, micWanted: true, ...o });
const baseS = (o = {}) => ({ ok: true, rec: { recording: false }, levels: null, counts: { segs: 0, errs: 0 }, follow: true, showPill: false, captionMode: 'read', otherSites: true, shortcut: 'Ctrl+Shift+Y', notice: { on: false, text: '', done: false }, nudge: { on: true, skipOneOnOne: true, meetingTypes: types, dismissed: [] }, ...o });
const NTEXT = 'This meeting is being transcribed by Debrief.';
const results = (p) => p.sent.filter((m) => m.type === 'notice-result');

await test('the pill: posts the recording notice once and reports it; room mode, paused, done, other apps and notice-off post nothing', async () => {
  const mk = (o, rec, notice = { on: true, text: NTEXT, done: false }, extra = {}) => fakePage({ S: baseS({ rec: recState(rec), notice, ...o }), ...extra });
  const ok = mk({}, {});
  const room = mk({}, { room: true });
  const paused = mk({}, { paused: true });
  const done = mk({}, {}, { on: true, text: NTEXT, done: true });
  const off = mk({}, {}, { on: false, text: NTEXT, done: false });
  const other = mk({}, {}, undefined, { generic: true, url: 'https://app.zoom.us/wc/123' });
  const elsewhere = mk({}, { tabId: 99 });
  await wait(1500);
  assert.deepEqual(ok.chat, [NTEXT]);
  assert.deepEqual(results(ok).map(({ type, ok: o, posted, why }) => ({ type, ok: o, posted, why })), [{ type: 'notice-result', ok: true, posted: true, why: '' }], 'reported once, and not posted again on the next ticks');
  for (const [name, p] of Object.entries({ room, paused, done, off, other, elsewhere })) {
    assert.deepEqual(p.chat, [], `${name}: nothing posted`);
    assert.deepEqual(results(p), [], `${name}: nothing reported`);
  }
  [ok, room, paused, done, off, other, elsewhere].forEach((p) => p.close());
});

await test('the pill: a notice that cannot be posted for good is reported once and shown once as an alert card, even with the pill switched off', async () => {
  const p = fakePage({ chatOff: true, S: baseS({ rec: recState(), notice: { on: true, text: NTEXT, done: false } }) });
  await wait(1700);
  assert.equal(results(p).length, 1, 'no retry for a permanent reason');
  assert.deepEqual({ ok: results(p)[0].ok, why: results(p)[0].why }, { ok: false, why: 'chat is turned off in this meeting' });
  const c = p.card();
  assert.ok(c, 'the alert card is up');
  assert.equal(c.getAttribute('role'), 'alert');
  assert.match(c.textContent, /Debrief could not post the recording notice in the chat \(chat is turned off in this meeting\)\. Please tell people yourself\./);
  assert.equal(p.host().style.display, '', 'the pill setting is off, the card still shows');
  assert.equal(p.root().querySelector('.pill').classList.contains('hidden'), true);
  [...c.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  assert.equal(p.card(), null);
  await wait(1200);
  assert.equal(p.card(), null, 'shown once');
  p.close();
});

await test('the pill: the record reminder shows one card, Not now dismisses it, and Don\'t remind me turns the setting off', async () => {
  const S = baseS();
  const p = fakePage({ S });
  await wait(300);
  let c = p.card();
  assert.ok(c, 'the card is up');
  assert.equal(c.getAttribute('role'), 'status');
  assert.match(c.textContent, /This looks like your "Daily standup"\. Press Ctrl\+Shift\+Y or click the Debrief button to record it\./);
  assert.equal(p.host().style.display, '', 'shown although the pill on the page is off');
  assert.equal(p.root().querySelectorAll('.alertbox').length, 1);
  assert.deepEqual(p.sent.filter((m) => m.type === 'nudge-dismiss'), [], 'the tab is in view: no system notification');
  [...c.querySelectorAll('button')].find((b) => b.textContent === 'Not now').click();
  assert.equal(p.card(), null);
  assert.deepEqual(p.sent.filter((m) => m.type === 'nudge-dismiss'), [{ target: 'bg', type: 'nudge-dismiss', key: 'meet:abc-defg-hij' }]);
  await wait(1200);
  assert.equal(p.card(), null, 'stays away');
  p.close();
  const q = fakePage({ S: baseS() });
  await wait(300);
  [...q.card().querySelectorAll('button')].find((b) => b.textContent === "Don't remind me").click();
  assert.deepEqual(q.sent.filter((m) => m.type === 'set-nudge'), [{ target: 'bg', type: 'set-nudge', on: false }]);
  assert.equal(q.card(), null);
  q.close();
});

await test('the pill: the reminder goes when recording starts and does not return; it is not asked on other titles, in one-on-ones, or when switched off; a hidden tab asks for one notification', async () => {
  const S = baseS();
  const p = fakePage({ S });
  await wait(300);
  assert.ok(p.card());
  S.rec = recState({ tabId: 99 }); // recording (another tab): nothing to ask
  await wait(1100);
  assert.equal(p.card(), null, 'hidden when recording starts');
  S.rec = { recording: false };
  await wait(1100);
  assert.equal(p.card(), null, 'once per call');
  p.close();
  for (const [name, o, S2] of [
    ['other title', { title: 'Lunch - Google Meet' }, baseS()],
    ['one-on-one', { people: 2 }, baseS()],
    ['off', {}, baseS({ nudge: { on: false, skipOneOnOne: true, meetingTypes: [], dismissed: [] } })],
    ['dismissed before a reload', {}, baseS({ nudge: { on: true, skipOneOnOne: true, meetingTypes: types, dismissed: ['meet:abc-defg-hij'] } })],
  ]) {
    const q = fakePage({ S: S2, ...o });
    await wait(300);
    assert.equal(q.card(), null, name);
    q.close();
  }
  const h = fakePage({ S: baseS(), visible: false });
  await wait(1300);
  assert.equal(h.window.document.hidden, true);
  assert.deepEqual(h.sent.filter((m) => m.type === 'nudge-dismiss'), [{ target: 'bg', type: 'nudge-dismiss', key: 'meet:abc-defg-hij', notified: true }], 'asked once for the notification');
  h.close();
});

await test('the pill: presenting is reported when it changes and once after the recording starts; not on other apps or when not recording', async () => {
  const p = fakePage({ S: baseS({ rec: recState() }) });
  const idle = fakePage({ S: baseS() });
  const other = fakePage({ generic: true, url: 'https://app.zoom.us/wc/123', S: baseS({ rec: recState() }) });
  const pres = (x) => x.sent.filter((m) => m.type === 'presenting');
  await wait(400);
  assert.deepEqual(pres(p), [{ target: 'bg', type: 'presenting', on: false, name: null }]);
  p.doc.getElementById('banner').innerHTML = '<div role="status">Priya Nair is presenting</div>';
  await wait(5300); // the page is read for it every 5 s
  assert.deepEqual(pres(p).at(-1), { target: 'bg', type: 'presenting', on: true, name: 'Priya Nair' });
  await wait(1100);
  assert.equal(pres(p).length, 2, 'nothing more while nothing changes');
  p.doc.getElementById('banner').innerHTML = '';
  await wait(5300);
  assert.deepEqual(pres(p).at(-1), { target: 'bg', type: 'presenting', on: false, name: null });
  assert.equal(pres(idle).length, 0);
  assert.equal(pres(other).length, 0);
  [p, idle, other].forEach((x) => x.close());
});

// how many times the pill reads the page for what, counted on the document's own query calls
const countQueries = (doc, patterns) => {
  const n = Object.fromEntries(Object.keys(patterns).map((k) => [k, 0]));
  const real = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => {
    for (const [k, re] of Object.entries(patterns)) if (re.test(sel)) n[k]++;
    return real(sel);
  };
  return n;
};
const PATTERNS = { presenting: /^\[aria-label\], \[title\]$/, people: /role="list"/ };

await test('the pill: the page is scanned for presenting only every 5 s and only while recording with screen notes on', async () => {
  const rec = fakePage({ S: baseS({ rec: recState() }) });
  const off = fakePage({ S: baseS({ rec: recState(), screenNotes: false }) });
  const idle = fakePage({ S: baseS() });
  const nRec = countQueries(rec.doc, PATTERNS);
  const nOff = countQueries(off.doc, PATTERNS);
  const nIdle = countQueries(idle.doc, PATTERNS);
  await wait(6200); // about six ticks
  assert.ok(nRec.presenting >= 1 && nRec.presenting <= 2, `recording: ${nRec.presenting} scans in 6 s (was one per tick)`);
  assert.equal(nOff.presenting, 0, 'screen notes off: never');
  assert.equal(nIdle.presenting, 0, 'not recording: never');
  [rec, off, idle].forEach((x) => x.close());
});

await test('the pill: participants are read for the reminder only while it can still be asked: not switched off, and not again after it was shown', async () => {
  const recording = fakePage({ S: baseS({ rec: recState() }) });
  const off = fakePage({ S: baseS({ nudge: { on: false, skipOneOnOne: true, meetingTypes: types, dismissed: [] } }) });
  const asked = fakePage({ S: baseS() });
  const nOff = countQueries(off.doc, PATTERNS);
  const nAsked = countQueries(asked.doc, PATTERNS);
  await wait(300);
  assert.ok(asked.card(), 'the reminder is up');
  const atShown = nAsked.people;
  await wait(3100);
  assert.equal(nAsked.people, atShown, 'once it is up the people are not read again');
  assert.equal(nOff.people, 0, 'reminders off');
  [recording, off, asked].forEach((x) => x.close());
});

// ---------------------------------------------------------------- who may send what (security review L1, M1)
import { readFileSync } from 'node:fs';
const BG = await import('../src/background.js'); // the same module the harness loaded: its exports
// Every handler of the worker, and whether a script on a meeting page may reach it. A new handler must be added here,
// so it can never be opened to pages by accident.
const EXPOSURE = {
  start: false, stop: true, discard: true, 'window-fullscreen': true, mic: true, pause: true, 'mic-refresh': false, 'meet-mute': true, whoami: true, level: false,
  'meet-ended': true, 'mic-silent': false, 'learn-voices': false, 'job-run': false, 'job-hold': false, 'job-abort': false, 'offscreen-idle': false, notify: false, store: false,
  dbg: false, segment: false, 'screen-note': false, 'live-state': false, 'notice-result': true, presenting: true, 'nudge-dismiss': true, 'set-nudge': true, 'stt-error': false,
  gap: false, silence: false, usage: false, 'meet-snap': true, 'in-call': true, 'voice-seg': false, 'dismiss-alert': true, 'set-follow': true, 'webhook-post': false, 'pill-state': true,
};
const handlerNames = () => {
  const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const handlers = {'), src.indexOf('let h = handlers[msg.type]'));
  return [...block.matchAll(/^ {4}(?:'([a-z-]+)'|([a-z]+)):/gm)].map((m) => m[1] || m[2]);
};
const IFRAME_SCRIPT = { id: 'testid', tab: { id: 7 }, frameId: 4, url: 'https://evil.example/ad-frame.html' };
const PANEL_FRAME = { id: 'testid', tab: { id: 99 }, frameId: 5, url: 'chrome-extension://testid/popup.html' };

await test('exposure: every handler is in the table, and the table is exactly what a meeting page may reach', async () => {
  const names = handlerNames();
  assert.ok(names.length >= 38, `found ${names.length} handlers`);
  assert.deepEqual([...names].sort(), Object.keys(EXPOSURE).sort(), 'a handler was added or removed: classify it in EXPOSURE');
  assert.deepEqual([...BG.PAGE_MAY].sort(), Object.keys(EXPOSURE).filter((k) => EXPOSURE[k]).sort());
  for (const [type, open] of Object.entries(EXPOSURE)) {
    if (open) continue; // the open ones are sent below with a harmless state
    for (const who of [page(7), IFRAME_SCRIPT, { id: 'testid', tab: { id: 7 }, url: 'https://chrome-extension.testid.evil/x' }, { id: 'testid', tab: { id: 7 } }])
      assert.equal(await send({ type, meetingId: 'mt', id: 'mt', op: 'settings' }, who), 'NO-HANDLER', `${type} must not be reachable from ${who.url}`);
  }
  for (const type of Object.keys(EXPOSURE).filter((k) => EXPOSURE[k])) assert.notEqual(await send({ type }, page(7)), 'NO-HANDLER', `${type} is for the pill`);
});

await test('exposure: own pages are told apart by the URL Chrome sets, not by having a tab', () => {
  assert.equal(BG.isOwnPage(OFFSCREEN), true);
  assert.equal(BG.isOwnPage(PANEL_FRAME), true, 'the floating panel is our page inside a meeting tab');
  assert.equal(BG.isOwnPage({ id: 'testid', tab: { id: 2 }, url: 'chrome-extension://testid/mom.html?id=m1' }), true);
  assert.equal(BG.isOwnPage(page(7)), false);
  assert.equal(BG.isOwnPage(IFRAME_SCRIPT), false);
  assert.equal(BG.isOwnPage({ id: 'testid', tab: { id: 7 }, url: 'chrome-extension://testidx/popup.html' }), false, 'another id that starts the same');
});

await test('L1: stop, discard, mic, follow and dismiss from a script in another tab are refused; the recorded tab and own pages still work', async () => {
  live({ alert: { kind: 'quota', at: 1, notifiedAt: 1 } });
  state.mem.local.settings = { followMeetMute: true };
  for (const type of ['stop', 'discard', 'mic', 'set-follow', 'dismiss-alert']) assert.deepEqual(await send({ type, on: false }, page(99)), { ok: false }, type);
  assert.deepEqual(await send({ type: 'stop' }, IFRAME_SCRIPT.tab.id === 7 ? { ...IFRAME_SCRIPT, tab: { id: 98 } } : IFRAME_SCRIPT), { ok: false });
  assert.equal(state.mem.session.rec.recording, true, 'still recording');
  assert.equal(state.mem.session.rec.micWanted, true);
  assert.ok(state.mem.session.rec.alert, 'alert still there');
  assert.equal(state.mem.local.settings.followMeetMute, true);
  assert.ok(state.mem.local['meeting:mt'], 'not discarded');
  assert.equal((await send({ type: 'mic', on: false }, page(7))).ok, true, 'the recorded tab may');
  assert.equal(state.mem.session.rec.micWanted, false);
  await send({ type: 'dismiss-alert' }, PANEL_FRAME);
  assert.equal(state.mem.session.rec.alert, null, 'the panel in any tab is an own page');
  assert.deepEqual(await send({ type: 'set-follow', on: false }, page(7)), { ok: true, micOn: false, micWanted: false });
  assert.equal(state.mem.local.settings.followMeetMute, false);
  state.mem.session.rec.recording = false;
  assert.deepEqual(await send({ type: 'stop' }, page(7)), { ok: false }, 'not recording: a page has nothing to stop');
});

await test('M1: webhook-post loads the meeting and settings itself, needs the permission, and takes no address from the message', async () => {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => (fetched.push([String(u), JSON.parse(init.body)]), { status: 200 });
  const perms = [];
  let allow = false;
  chrome.permissions = { contains: async (q) => (perms.push(q), allow) };
  try {
    live();
    state.mem.local['meeting:mt'].mom = '## Decisions\n- Ship. [0:10] "kal ship"';
    state.mem.local.settings = { webhookUrl: 'https://hooks.example.com/abc' };
    const msg = { type: 'webhook-post', meetingId: 'mt', url: 'https://attacker.example/x', meeting: { mom: 'forged' }, settings: { webhookUrl: 'https://attacker.example/x' } };
    assert.deepEqual(await send(msg, OFFSCREEN), { ok: false, status: 0, error: 'Debrief has no permission for this address. Open Settings and save the webhook again.' });
    assert.deepEqual(perms, [{ origins: ['https://hooks.example.com/*'] }]);
    assert.deepEqual(fetched, []);
    allow = true;
    assert.deepEqual(await send(msg, OFFSCREEN), { ok: true, status: 200 });
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0][0], 'https://hooks.example.com/abc');
    assert.equal(fetched[0][1].meeting.id, 'mt');
    assert.ok(!JSON.stringify(fetched[0][1]).includes('forged') && !JSON.stringify(fetched[0][1]).includes('kal ship'));
    assert.equal(await send(msg, page(7)), 'NO-HANDLER', 'never from a meeting page');
    assert.equal((await send({ type: 'webhook-post', meetingId: 'nope' }, OFFSCREEN)).ok, false);
    assert.equal((await send({ type: 'webhook-post', meetingId: { id: 'mt' } }, OFFSCREEN)).ok, false);
    delete chrome.permissions;
    assert.equal((await send(msg, OFFSCREEN)).error, 'Debrief has no permission for this address. Open Settings and save the webhook again.', 'no permissions API: no');
    assert.equal(fetched.length, 1);
  } finally {
    delete chrome.permissions;
    globalThis.fetch = realFetch;
  }
});

await test('L3: kept recordings past their days are deleted when the worker starts, at most every 6 hours', async () => {
  const K = await import('../src/audiokeep.js');
  const now = Date.now();
  await K.putSeg({ meetingId: 'old', seq: 0, t0: 0, dur: 30, blob: null, savedAt: now - 20 * 86400000 });
  await K.putSeg({ meetingId: 'new', seq: 0, t0: 0, dur: 30, blob: null, savedAt: now - 86400000 });
  state.mem.local.settings = { keepAudioDays: 14 };
  assert.equal(await BG.purgeKeptAudio(now), 1);
  assert.deepEqual([(await K.listSegs('old')).length, (await K.listSegs('new')).length], [0, 1]);
  await K.putSeg({ meetingId: 'old', seq: 1, t0: 0, dur: 30, blob: null, savedAt: now - 20 * 86400000 });
  assert.equal(await BG.purgeKeptAudio(now + 3600000), null, 'not again within 6 hours');
  assert.equal(await BG.purgeKeptAudio(now + 6 * 3600000 + 1), 1);
  state.mem.local.settings = { keepAudioDays: 0 };
  state.mem.session.keptPurgedAt = 0;
  assert.equal(await BG.purgeKeptAudio(now), 0, '0 days: kept until the meeting is deleted');
  assert.equal((await K.listSegs('new')).length, 1);
  await K.deleteAudio('new');
  assert.match(readFileSync(new URL('../src/background.js', import.meta.url), 'utf8'), /^purgeKeptAudio\(\)\.catch/m, 'run when the worker starts');
});

console.log(`\n${passed} passed`);
process.exit(process.exitCode || 0);
