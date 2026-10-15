// The real service worker run against a fake chrome API (see bg-harness.mjs).
import assert from 'node:assert/strict';
const { send, state } = await import('./bg-harness.mjs');

let passed = 0;
async function test(name, fn) {
  try {
    state.mem.local = {};
    state.mem.session = {};
    state.created.length = 0;
    for (const o of [state.badge, state.title, state.icon]) for (const k of Object.keys(o)) delete o[k];
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const OWN = { id: 'testid', url: 'chrome-extension://testid/popup.html' };
const OFFSCREEN = { id: 'testid', url: 'chrome-extension://testid/offscreen.html' };
const page = (tab, url = 'https://app.zoom.us/wc/1') => ({ id: 'testid', tab: { id: tab }, url });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (extra = {}) => {
  state.mem.session.rec = { recording: true, meetingId: 'mt', tabId: 7, startedAt: Date.now() - 5000, mic: true, micOn: true, micWanted: true, meetMuted: null, ...extra };
  state.mem.local['meeting:mt'] = { id: 'mt', title: 'T', startedAt: Date.now() - 5000, endedAt: null, segments: [], errors: [], mom: '' };
  state.mem.local.meetingIds = ['mt'];
};

await test('every handler the product needs is registered', async () => {
  for (const type of ['start', 'stop', 'mic', 'mic-refresh', 'meet-mute', 'whoami', 'level', 'meet-ended', 'dbg', 'segment', 'stt-error', 'usage', 'meet-snap', 'in-call', 'dismiss-alert', 'set-follow', 'pill-state']) {
    const r = await send({ type }, type === 'whoami' ? page(3) : OWN);
    assert.notEqual(r, 'NO-HANDLER', `${type} has no handler`);
  }
});

await test('transcript segments from the recorder are saved in the meeting', async () => {
  live();
  assert.deepEqual(await send({ type: 'segment', meetingId: 'mt', seg: { t: 1, src: 'others', text: 'hello' } }, OFFSCREEN), { ok: true });
  await send({ type: 'segment', meetingId: 'mt', seg: { t: 2, src: 'me', text: 'hi' } }, OFFSCREEN);
  await send({ type: 'dbg', meetingId: 'mt', note: 'n' }, OFFSCREEN);
  const m = state.mem.local['meeting:mt'];
  assert.deepEqual(m.segments.map((s) => s.text), ['hello', 'hi']);
  assert.deepEqual(m.debug, ['n']);
});

await test('usage is counted and survives many concurrent messages', async () => {
  await Promise.all(Array.from({ length: 25 }, () => send({ type: 'usage', entry: { provider: 'gemini', model: 'm', kind: 'llm', req: 1 } }, OFFSCREEN)));
  const day = Object.values(state.mem.local.usage)[0];
  assert.equal(day['gemini|m|llm'].req, 25);
});

await test('a quota error raises one alert and a later segment clears it', async () => {
  live();
  await send({ type: 'stt-error', meetingId: 'mt', error: '[10s me] Gemini HTTP 429: quota, limit: 20, model: gemini-3.8-flash' }, OFFSCREEN);
  assert.equal(state.mem.session.rec.alert.kind, 'quota');
  assert.match(state.mem.local['meeting:mt'].errors[0], /429/);
  await send({ type: 'segment', meetingId: 'mt', seg: { t: 5, src: 'others', text: 'ok' } }, OFFSCREEN);
  assert.equal(state.mem.session.rec.alert, null);
});

await test('end of the meeting from the recorded tab stops it; another tab cannot', async () => {
  live();
  assert.deepEqual(await send({ type: 'meet-ended' }, page(99)), { ok: false });
  assert.equal(state.mem.session.rec.recording, true);
  assert.deepEqual(await send({ type: 'meet-ended' }, page(7)), { ok: true });
  assert.equal(state.mem.session.rec.recording, false);
  assert.ok(state.mem.local['meeting:mt'].endedAt);
  assert.equal(state.created.length, 1);
  assert.match(state.created[0].url, /mom\.html\?id=mt/);
  assert.equal(state.created[0].active, false, 'an automatic stop opens the minutes in the background');
});

await test('auto-stop can be switched off', async () => {
  live();
  state.mem.local.settings = { autoStop: false };
  assert.deepEqual(await send({ type: 'meet-ended' }, page(7)), { ok: false });
  assert.equal(state.mem.session.rec.recording, true);
});

await test('a page script cannot forge recorder messages, but may use its own', async () => {
  live();
  for (const type of ['segment', 'stt-error', 'usage', 'dbg', 'start']) {
    assert.equal(await send({ type, meetingId: 'mt', seg: { t: 1, text: 'FORGED' }, entry: { provider: 'x', kind: 'llm', req: 9 }, error: 'x', note: 'x' }, page(7)), 'NO-HANDLER', `${type} from a page must be ignored`);
  }
  assert.equal(state.mem.local['meeting:mt'].segments.length, 0);
  assert.equal(state.mem.local.usage, undefined);
  assert.notEqual(await send({ type: 'in-call', on: true, site: 'Zoom' }, page(7)), 'NO-HANDLER');
  assert.equal(await send({ type: 'segment', meetingId: 'mt', seg: { t: 1, text: 'x' } }, { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' }), 'NO-HANDLER', 'other extensions are ignored');
});

await test('silence: never ends a quiet lobby, ends a meeting that went quiet after sound', async () => {
  live();
  state.mem.session.quietSince = Date.now() - 20 * 60000;
  state.mem.session.heard = false;
  await send({ type: 'level', tab: 0.001, mic: null }, OFFSCREEN);
  assert.equal(state.mem.session.rec.recording, true, 'nothing was ever heard, so this is not a finished meeting');
  await send({ type: 'level', tab: 0.2, mic: null }, OFFSCREEN);
  assert.equal(state.mem.session.heard, true);
  state.mem.session.quietSince = Date.now() - 11 * 60000;
  await send({ type: 'level', tab: 0.001, mic: null }, OFFSCREEN);
  await wait(300);
  assert.equal(state.mem.session.rec.recording, false);
});

await test('mic switch and Meet mute arriving together both survive', async () => {
  live({ micWanted: true, meetMuted: false });
  state.mem.local.settings = { followMeetMute: true };
  await Promise.all([send({ type: 'meet-mute', muted: true }, page(7)), send({ type: 'mic', on: true }, OWN), send({ type: 'meet-mute', muted: true }, page(7))]);
  const rec = state.mem.session.rec;
  assert.equal(rec.meetMuted, true);
  assert.equal(rec.micWanted, true);
  assert.equal(rec.micOn, false, 'muted in the meeting, so the mic is paused');
  await send({ type: 'meet-mute', muted: false }, page(7));
  assert.equal(state.mem.session.rec.micOn, true);
});

await test('every change of Meet mute is written to the meeting log, and a silent microphone raises an alert', async () => {
  live({ micWanted: true, meetMuted: false });
  state.mem.local.settings = { followMeetMute: true };
  await send({ type: 'meet-mute', muted: true }, page(7));
  await send({ type: 'meet-mute', muted: false }, page(7));
  await send({ type: 'meet-mute', muted: null }, page(7));
  await new Promise((r) => setTimeout(r, 50));
  const dbg = (state.mem.local['meeting:mt'].debug || []).filter((x) => /^Meet mic/.test(x));
  assert.equal(dbg.length, 3, JSON.stringify(dbg));
  assert.match(dbg[0], /muted at \+\d+s; Debrief mic off/);
  assert.match(dbg[1], /unmuted.*Debrief mic on/);
  assert.match(dbg[2], /not detected/);
  live();
  await send({ type: 'mic-silent', meetingId: 'mt' }, OFFSCREEN);
  assert.equal(state.mem.session.rec.alert?.kind, 'mic');
});

await test('room mode: the microphone stays on when Meet says muted, and microphone pieces of speech are stored with their origin', async () => {
  live({ micWanted: true, meetMuted: false, room: true });
  state.mem.local.settings = { followMeetMute: true };
  await send({ type: 'meet-mute', muted: true }, page(7));
  assert.equal(state.mem.session.rec.micOn, true, 'in a room the mic is the meeting');
  live({ micWanted: true, meetMuted: false, room: false });
  state.mem.local.settings = { followMeetMute: true };
  await send({ type: 'meet-mute', muted: false }, page(7));
  await send({ type: 'meet-mute', muted: true }, page(7));
  assert.equal(state.mem.session.rec.micOn, false, 'outside room mode muting still pauses the mic');
  live();
  await send({ type: 'voice-seg', meetingId: 'mt', segs: [{ t0: 1, t1: 4, e: 'AAAA', s: 'm', extra: 'dropped' }, { t0: 5, t1: 8, e: 'BBBB' }] }, OFFSCREEN);
  const segs = state.mem.local['meeting:mt'].voiceSegs;
  assert.deepEqual(segs, [{ t0: 1, t1: 4, e: 'AAAA', s: 'm' }, { t0: 5, t1: 8, e: 'BBBB' }]);
});

await test('pause: pausing tells the recorder, shows the badge, notes the pause on the meeting and stops the silence safety net; resume undoes it', async () => {
  live({ micWanted: true });
  state.mem.local.settings = { autoStop: true, autoStopQuietMin: 1 };
  state.offLog.length = 0;
  const a = await send({ type: 'pause', on: true }, OWN);
  assert.equal(a.paused, true);
  assert.equal(state.mem.session.rec.paused, true);
  assert.deepEqual(state.offLog.filter((m) => m.type === 'pause').map((m) => m.on), [true]);
  assert.equal(state.badge.g, 'II');
  const during = state.mem.local['meeting:mt'].pauses;
  assert.equal(during.length, 1);
  assert.equal(during[0].to, null);
  // a long quiet stretch while paused never stops the recording
  state.mem.session.quietSince = Date.now() - 10 * 60000;
  state.mem.session.heard = true;
  await send({ type: 'level', tab: 0, mic: 0, ctx: 'running' }, OFFSCREEN);
  assert.equal(state.mem.session.rec.recording, true, 'paused is not silent');
  // pausing again does nothing, toggling resumes
  await send({ type: 'pause', on: true }, OWN);
  assert.equal(state.mem.local['meeting:mt'].pauses.length, 1);
  const b = await send({ type: 'pause' }, OWN);
  assert.equal(b.paused, false);
  assert.equal(state.badge.g, 'REC');
  assert.equal(typeof state.mem.local['meeting:mt'].pauses[0].to, 'number');
  assert.deepEqual(state.offLog.filter((m) => m.type === 'pause').map((m) => m.on), [true, false]);
  // stopping while paused closes the pause
  await send({ type: 'pause', on: true }, OWN);
  await send({ type: 'stop' }, OWN);
  const last = state.mem.local['meeting:mt'].pauses.at(-1);
  assert.equal(typeof last.to, 'number');
});

await test('a late message during stop cannot bring a stopped recording back', async () => {
  live();
  const stopping = send({ type: 'stop' }, OWN);
  const late = [send({ type: 'stt-error', meetingId: 'mt', error: 'Gemini HTTP 429 quota' }, OFFSCREEN), send({ type: 'mic', on: false }, OWN), send({ type: 'meet-mute', muted: true }, page(7)), send({ type: 'dismiss-alert' }, OWN)];
  await Promise.all([stopping, ...late]);
  await wait(200);
  assert.equal(state.mem.session.rec.recording, false);
  assert.equal(state.mem.session.rec.stopping, undefined, 'no half-stopped leftovers');
});

await test('pressing start twice does not start two recordings', async () => {
  const sttReady = { sttProvider: 'gemini', geminiKey: 'k', sttGeminiModel: 'm' };
  state.mem.local.settings = sttReady;
  const [a, b] = await Promise.all([send({ type: 'start', streamId: 's', tabId: 7, title: 'Meet - Sync - Google Meet', url: 'https://meet.google.com/abc-defg-hij' }, OWN), send({ type: 'start', streamId: 's', tabId: 7, title: 'x', url: 'https://meet.google.com/abc-defg-hij' }, OWN)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(state.mem.session.rec.recording, true);
  assert.equal(state.mem.session.rec.meetCode, 'abc-defg-hij');
  assert.equal(Object.keys(state.mem.local).filter((k) => k.startsWith('meeting:')).length, 1, 'only one meeting record');
  assert.equal(state.mem.local['meeting:' + state.mem.session.rec.meetingId].title, 'Sync');
});

await test('the page-facing state never carries keys', async () => {
  live();
  state.mem.local.settings = { geminiKey: 'SECRET-KEY-123', emailSecret: 'SECRET-RELAY', emailWebhook: 'https://script.google.com/macros/s/x/exec' };
  const r = await send({ type: 'pill-state' }, page(7));
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /SECRET-KEY|SECRET-RELAY|script\.google/);
});

await test('turning off follow-mute writes only that setting', async () => {
  state.mem.local.settings = { myName: 'Me' };
  live();
  await send({ type: 'set-follow', on: false }, page(7));
  assert.deepEqual(state.mem.local.settings, { myName: 'Me', followMeetMute: false });
});

await test('the amber call dot follows the page and is left alone while recording that tab', async () => {
  await send({ type: 'in-call', on: true, site: 'Zoom (web client)' }, page(5));
  assert.equal(state.badge[5], '●');
  await send({ type: 'in-call', on: false }, page(5));
  assert.equal(state.badge[5], '');
  live({ tabId: 5 });
  state.badge[5] = 'REC';
  await send({ type: 'in-call', on: true, site: 'Zoom' }, page(5));
  assert.equal(state.badge[5], 'REC');
});

await test('toolbar: call-on glows by swapping the icon, tooltip is the artboard text, and it stops cleanly', async () => {
  await send({ type: 'in-call', on: true, site: 'Zoom' }, page(5));
  assert.equal(state.title[5], 'A call is on. Click to record.');
  assert.equal(state.icon[5], 'icons/icon16-glow.png');
  await wait(700);
  assert.equal(state.icon[5], 'icons/icon16.png', 'swapped to the plain frame after 600 ms');
  await wait(600);
  assert.equal(state.icon[5], 'icons/icon16-glow.png', 'and back');
  await send({ type: 'in-call', on: false }, page(5));
  assert.equal(state.icon[5], 'icons/icon16.png');
  assert.equal(state.title[5], 'Debrief');
  assert.equal(state.badge[5], '');
  state.icon[5] = 'untouched';
  await wait(1300);
  assert.equal(state.icon[5], 'untouched', 'no timer is left running after the last glow stops');
});

await test('toolbar: recording ends the glow, shows REC with a live tooltip, ! on an alert, resets on stop', async () => {
  await send({ type: 'in-call', on: true, site: 'Meet' }, page(7));
  const r = await send({ type: 'start', streamId: 's', tabId: 7, title: 'Meet - Sync - Google Meet', url: 'https://meet.google.com/abc-defg-hij' }, OWN);
  assert.equal(r.ok, true);
  assert.equal(state.badge[7], 'REC');
  assert.equal(state.badge.g, 'REC');
  assert.match(state.title[7], /^Recording · 0:0\d$/);
  assert.equal(state.icon[7], 'icons/icon16.png', 'plain icon, glow ended');
  state.icon[7] = 'untouched';
  await wait(1300);
  assert.equal(state.icon[7], 'untouched', 'the glow timer stopped when recording started');
  const meetingId = state.mem.session.rec.meetingId;
  await send({ type: 'stt-error', meetingId, error: '[10s me] Gemini HTTP 429: quota, limit: 20, model: gemini-3.8-flash' }, OFFSCREEN);
  assert.equal(state.badge[7], '!');
  assert.equal(state.title[7], 'Debrief needs attention');
  await send({ type: 'segment', meetingId, seg: { t: 5, src: 'others', text: 'ok' } }, OFFSCREEN);
  assert.equal(state.badge[7], 'REC', 'attention clears when transcription resumes');
  await send({ type: 'stop' }, OWN);
  assert.equal(state.badge[7], '');
  assert.equal(state.badge.g, '');
  assert.equal(state.title[7], 'Debrief');
});

console.log(`\n${passed} passed`);
process.exit(process.exitCode || 0);
