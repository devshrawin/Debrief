import { isIconText, isMenuText } from './iconText.js';
import { learnFromMeeting, learnRecurring } from './voice/learn.js';
import { roomFor } from './room.js';
import { saveSamples } from './voice/sampling.js';
import { classifyError } from './alerts.js';
import { MEET_CODE } from './meetend.js';
import { addEntry } from './usage.js';
import { cleanTitle } from './adapters/pillrules.js';
import { stuckJobs } from './jobstate.js';
import { postIfPermitted } from './webhook.js';
import { purgeOld } from './audiokeep.js';
import { purgePendingOld } from './audiostore.js';
import { keepStatuses, tickItems, reviewItems } from './actions.js';
import { SCHEMA, getSettings, setSetting, sttReady, getMeeting, getMeetingMeta, listMeetingMetas, saveMeeting, patchMeeting, updateMeetingMeta, appendMeeting, editMeetingTail, CAPS, deleteMeeting, addMeetingId, getState, setState, saveVoices, plain, findTyped, getBlockedVoices, getEmailNames, mergeEmailNames } from './store.js';

// First install: show the guided tour. (Updates stay quiet; the popup has a Take the tour link.)
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.storage.local.set({ schema: SCHEMA }); // a new install starts generic: nothing to migrate
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?restart=1') });
});

// ---- Toolbar icon states: idle, call on (glow), recording (REC badge), needs attention ----
// Every call is fire-and-forget: a tab can close between the event and the call.
const quiet = (p) => Promise.resolve(p).catch(() => {});
const TIP_IDLE = 'Debrief';
const TIP_CALL = 'A call is on. Click to record.';
const TIP_ATTN = 'Debrief needs attention';
const ICON_IDLE = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' };
const ICON_GLOW = { 16: 'icons/icon16-glow.png', 32: 'icons/icon32-glow.png', 48: 'icons/icon48-glow.png' };
const setIcon = (tabId, glow) => quiet(chrome.action.setIcon({ tabId, path: glow ? ICON_GLOW : ICON_IDLE }));
// "Hide the recording icon" (Settings → Appearance): no glow and no call/REC badge; the "!" badge still shows.
let hideRecIcon = false;
try {
  getSettings().then((s) => (hideRecIcon = !!s.hideRecIcon), () => {});
  chrome.storage.onChanged?.addListener((c, area) => {
    if (area === 'local' && c.settings) hideRecIcon = !!c.settings.newValue?.hideRecIcon;
  });
  // limits learned before 1.1.3 may be per-minute numbers taken for daily ones; they are learned again from real daily errors
  chrome.storage.local.get('limitsFixed').then(({ limitsFixed }) => (limitsFixed ? 0 : chrome.storage.local.remove('learnedLimits').then(() => chrome.storage.local.set({ limitsFixed: true }))), () => {});
} catch {}
const setBadge = (tabId, text, color) => {
  if (hideRecIcon && text && text !== '!') text = '';
  const t = tabId == null ? {} : { tabId };
  if (color) quiet(chrome.action.setBadgeBackgroundColor({ ...t, color }));
  quiet(chrome.action.setBadgeText({ ...t, text }));
};
const setTip = (tabId, title) => quiet(chrome.action.setTitle(tabId == null ? { title } : { tabId, title }));

// Call-on glow: the icon image alternates between plain and glow every 600 ms (static under reduced motion
// cannot be detected in a service worker, so it stays gentle: a halo, no movement). One shared interval, started
// with the first glowing tab and cleared with the last, so it can neither leak nor double up. If the worker is
// stopped the icon simply stays on whichever frame it had; the next 'in-call' message from the page restarts it.
const GLOW_MS = 600;
const glowTabs = new Set();
let glowTimer = null;
let glowPhase = false;
function endGlowTimer() {
  if (glowTabs.size || !glowTimer) return;
  clearInterval(glowTimer);
  glowTimer = null;
  glowPhase = false;
}
function startGlow(tabId) {
  if (hideRecIcon || glowTabs.has(tabId)) return;
  if (!glowTimer) glowPhase = true; // the first frame is the glow
  glowTabs.add(tabId);
  setIcon(tabId, glowPhase);
  glowTimer ||= setInterval(() => {
    glowPhase = !glowPhase;
    for (const t of glowTabs) setIcon(t, glowPhase);
  }, GLOW_MS);
}
function stopGlow(tabId) {
  if (!glowTabs.delete(tabId)) return;
  setIcon(tabId, false);
  endGlowTimer();
}
function showCallOn(tabId) {
  setBadge(tabId, '●', '#F59E0B'); // static amber dot: the fallback if the glow is not noticed
  setTip(tabId, TIP_CALL);
  startGlow(tabId);
}
function showCallOff(tabId) {
  stopGlow(tabId);
  setBadge(tabId, '');
  setTip(tabId, TIP_IDLE);
}

// Recording: red REC badge (never animated) with a live tooltip; a dark ! badge while something needs attention.
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
let rec = null; // { tabId, startedAt, attention }
let recTimer = null;
function paintRec() {
  if (!rec) return;
  const bad = rec.attention;
  const tip = bad ? TIP_ATTN : `${rec.paused ? 'Paused' : 'Recording'} · ${fmtElapsed(Date.now() - rec.startedAt)}`;
  for (const t of [null, rec.tabId]) {
    setBadge(t, bad ? '!' : rec.paused ? 'II' : 'REC', bad ? '#1d1f24' : rec.paused ? '#c25a00' : '#c8281c');
    setTip(t, tip);
  }
}
function showRec(tabId, startedAt, attention = false) {
  stopGlow(tabId); // the glow ends the moment recording starts
  rec = { tabId, startedAt, attention };
  paintRec();
  clearInterval(recTimer);
  recTimer = setInterval(paintRec, 5000);
}
function setAttention(on) {
  if (!rec || rec.attention === on) return;
  rec.attention = on;
  paintRec();
}
function hideRec(tabId) {
  clearInterval(recTimer);
  recTimer = null;
  rec = null;
  for (const t of [null, tabId]) {
    setBadge(t, '');
    setTip(t, TIP_IDLE);
  }
}
// After a service-worker restart in the middle of a recording, put the REC indicator back.
getState().then((st) => {
  if (st.recording && !st.stopping) {
    showRec(st.tabId, st.startedAt, !!st.alert);
    if (st.paused && rec) {
      rec.paused = true;
      paintRec();
    }
  }
}, () => {});

let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

// Every edit of the recorder state goes through this queue and re-reads the state inside it, so a late
// message can never write back an old copy (which used to leave a stopped recording marked as running).
const mutateState = (fn) =>
  serial(async () => {
    const next = await fn(await getState());
    if (next) await setState(next);
    return next;
  });

// Meeting writes go through the meeting store (src/meetingstore.js), which runs them one at a time per meeting. A transcript
// line, a debug note or a caption only rewrites the last chunk of its list, never the whole meeting.
const note = (id, text) => appendMeeting(id, 'debug', [text]);

// The live transcript page (if one is open) follows the recording through these. Nobody listening is normal.
function broadcast(meetingId, kind, item) {
  try {
    Promise.resolve(chrome.runtime.sendMessage({ target: 'live', type: 'live', meetingId, kind, item })).catch(() => {});
  } catch {}
}
const liveState = (st) => ({ recording: !!st.recording, paused: !!st.paused, startedAt: st.startedAt ?? null });

// The keyboard shortcut for "record", as the browser has it now (the user may have changed it); asked at most once a minute.
let shortcutCache = { at: 0, text: 'Alt+Shift+M' };
async function shortcutText() {
  if (Date.now() - shortcutCache.at < 60000) return shortcutCache.text;
  let text = 'Alt+Shift+M';
  try {
    const c = (await chrome.commands.getAll()).find((x) => x.name === 'toggle-recording');
    if (c?.shortcut) text = c.shortcut;
  } catch {}
  shortcutCache = { at: Date.now(), text };
  return text;
}

// Who was seen when ({ name: [first seen, last seen, sightings] }) changes with every snapshot of the meeting page, about
// once a second. It is kept here and written to the meeting at most every 15 s and when the recording stops. After a
// service-worker restart it is read back from the meeting, so at most the last 15 s of sightings can be lost.
const SCREEN_NOTES_MAX = 400; // screen notes kept per meeting
const PRESENCE_EVERY_MS = 15000;
const NAMES_MAX = 300; // names kept per meeting from the page's participant list
const NAME_MAX = 60;
let pres = null; // { id, map, dirty, at, timer, ready }
async function presenceFor(id) {
  if (pres?.id !== id) {
    const p = { id, map: Object.create(null), dirty: false, at: 0, timer: null }; // no prototype: a participant can be named __proto__ or constructor
    p.ready = getMeetingMeta(id, { counts: [] }).then((m) => (p.map = Object.assign(Object.create(null), m?.presence || {})), () => {});
    if (pres) flushPresence(pres).catch(() => {});
    pres = p;
  }
  const p = pres;
  await p.ready;
  return p;
}
function flushPresence(p = pres) {
  if (!p) return Promise.resolve();
  clearTimeout(p.timer);
  p.timer = null;
  if (!p.dirty) return Promise.resolve();
  p.dirty = false;
  p.at = Date.now();
  return patchMeeting(p.id, { presence: { ...p.map } }).catch(() => (p.dirty = true));
}
function presenceChanged(p) {
  p.dirty = true;
  const wait = PRESENCE_EVERY_MS - (Date.now() - p.at);
  if (wait <= 0) return flushPresence(p);
  if (!p.timer) {
    p.timer = setTimeout(() => flushPresence(p).catch(() => {}), wait);
    p.timer?.unref?.();
  }
  return Promise.resolve();
}
// The recording ended: write what is held now and forget it.
async function endPresence(id) {
  if (pres?.id !== id) return;
  const p = pres;
  pres = null;
  await p.ready;
  await flushPresence(p);
}

const voiceModelSet = new Set(); // meetings whose voiceModel was written since this worker started

// A notification needs its icon as a full address: written as 'icons/icon128.png' it is looked for next to the service worker
// (in dist/), is not found, and the whole notification fails with "Unable to download all specified images".
function notify(id, options) {
  try {
    chrome.notifications?.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), ...options }, () => void chrome.runtime.lastError);
  } catch {}
}

async function raiseAlert(meetingId, err) {
  const a = classifyError(err);
  if (!a) return;
  let fresh = false;
  await mutateState((st) => {
    if (!st.recording || st.stopping) return null;
    fresh = !st.alert || st.alert.kind !== a.kind || Date.now() - st.alert.notifiedAt > 10 * 60 * 1000;
    return { ...st, alert: { ...a, at: Date.now(), notifiedAt: fresh ? Date.now() : st.alert.notifiedAt } };
  });
  setAttention(true);
  if (fresh) {
    // No meeting title or addresses here: notifications can show on a shared screen.
    notify(`debrief-${a.kind}`, { title: `Debrief: ${a.title}`, message: a.detail, priority: 2 });
  }
}

async function clearAlert() {
  let had = false;
  await mutateState((st) => ((had = !!st.alert), st.alert ? { ...st, alert: null } : null));
  if (had) setAttention(false);
}

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctxs.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record meeting tab audio and microphone for transcription',
  });
}

async function closeOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctxs.length) return;
  // minutes being written there must not be cut off
  const busy = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'job-count' }).catch(() => null);
  if (busy?.count > 0) return;
  await chrome.offscreen.closeDocument();
}

// ---- minutes jobs: written and emailed in the offscreen document, so no minutes tab has to stay open ----
async function jobCommand(type, msg, { create = true } = {}) {
  if (create) await ensureOffscreen();
  else if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) return { ok: true, running: false };
  try {
    return (await chrome.runtime.sendMessage({ target: 'offscreen', type, ...msg })) || { ok: false };
  } catch {
    return { ok: false };
  }
}

async function startJob(id) {
  await patchMeeting(id, { job: { state: 'queued', beat: Date.now(), error: null } });
  return jobCommand('job-run', { id });
}

// After a restart (or when the service worker wakes), jobs that were running and have no runner any more are picked up.
async function resumeJobs() {
  const { meetingIds = [] } = await chrome.storage.local.get('meetingIds');
  const rows = await listMeetingMetas({ ids: meetingIds.slice(0, 30), counts: [] }); // job state is in META: no transcripts read
  for (const id of stuckJobs(rows)) await jobCommand('job-run', { id, resume: true });
}
resumeJobs().catch(() => {});
chrome.runtime.onStartup?.addListener(() => resumeJobs().catch(() => {}));

// Kept recordings older than "Delete kept recordings after" go when the worker starts (a browser start, or the worker
// waking for an event), at most every 6 hours, as well as when a recording starts. IndexedDB works here; no alarm needed.
const PURGE_EVERY_MS = 6 * 3600 * 1000;
export const PENDING_KEEP_DAYS = 30; // audio pieces that failed to transcribe are dropped after this long
export async function purgeKeptAudio(now = Date.now(), { force = false } = {}) {
  const { keptPurgedAt = 0 } = await chrome.storage.session.get('keptPurgedAt');
  if (!force && now - keptPurgedAt < PURGE_EVERY_MS) return null;
  const { keepAudioDays } = await getSettings();
  const n = await purgeOld(keepAudioDays, now);
  await purgePendingOld(PENDING_KEEP_DAYS, now).catch(() => {});
  await chrome.storage.session.set({ keptPurgedAt: now }); // only after the purge worked: a failed one is tried again at the next wake
  return n;
}
// Shortening "Delete kept recordings after" takes effect now, not at the next 6-hour slot.
try {
  chrome.storage.onChanged?.addListener((c, area) => {
    if (area === 'local' && c.settings && c.settings.newValue?.keepAudioDays !== c.settings.oldValue?.keepAudioDays) purgeKeptAudio(Date.now(), { force: true }).catch(() => {});
  });
} catch {}
purgeKeptAudio().catch(() => {});

let starting = false;
async function start(msg) {
  // The popup button and the keyboard shortcut can both fire while the microphone prompt is open.
  if (starting) return { ok: false, error: 'A recording is already starting.' };
  starting = true;
  try {
    return await startInner(msg);
  } finally {
    starting = false;
  }
}

async function startInner(msg) {
  const st = await getState();
  if (st.recording) return { ok: false, error: 'Already recording another tab.' };
  const settings = await getSettings();
  // Online meeting or a room: the user's choice in the popup, else decided by the link of the tab.
  const room = roomFor(msg.url, msg.room);
  const id = `m${Date.now()}`;
  await addMeetingId(id); // listed before the record is written: a record nobody lists would be invisible and never resumed
  await saveMeeting({
    id,
    room,
    title: cleanTitle(msg.title),
    url: msg.url,
    startedAt: Date.now(),
    endedAt: null,
    segments: [],
    errors: [],
    mom: '',
    stt: settings.sttProvider,
  });

  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: msg.streamId, settings: { ...settings, roomMode: room, captureMic: settings.captureMic || room }, meetingId: id }).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    await closeOffscreen();
    await patchMeeting(id, { endedAt: Date.now() });
    await appendMeeting(id, 'errors', [`Start failed: ${r?.error}`]);
    return { ok: false, error: r?.error || 'Recorder did not start.' };
  }
  await mutateState(() => ({ recording: true, room, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null, meetCode: (msg.url || '').match(MEET_CODE)?.[0] || null }));
  // The silence timer only starts once sound has been heard, so a quiet lobby never ends the recording.
  await chrome.storage.session.set({ quietSince: null, heard: false });
  // The pill is a content script; inject it now so it appears without reloading the Meet tab.
  chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['dist/pill.js'] }).catch(() => {});
  // A tab-specific badge (the Meet reminder) would hide the global one on that tab, so showRec sets both.
  showRec(msg.tabId, Date.now());
  broadcast(id, 'state', liveState({ recording: true, startedAt: rec.startedAt }));
  return { ok: true };
}

async function setWindowFullscreen(windowId, want, auto) {
  const id = windowId ?? (await chrome.windows.getLastFocused()).id;
  const w = await chrome.windows.get(id);
  const { fsPrev = {} } = await chrome.storage.session.get('fsPrev');
  const on = typeof want === 'boolean' ? want : w.state !== 'fullscreen';
  if (on) {
    if (w.state === 'fullscreen') return { ok: true, fullscreen: true };
    fsPrev[id] = w.state || 'normal';
    await chrome.storage.session.set({ fsPrev });
    await chrome.windows.update(id, { state: 'fullscreen' });
    return { ok: true, fullscreen: true };
  }
  if (w.state !== 'fullscreen') return { ok: true, fullscreen: false };
  if (auto && !(id in fsPrev)) return { ok: true, fullscreen: true }; // the user's own F11: not ours to undo
  const back = fsPrev[id] && fsPrev[id] !== 'fullscreen' ? fsPrev[id] : 'normal';
  delete fsPrev[id];
  await chrome.storage.session.set({ fsPrev });
  await chrome.windows.update(id, { state: back });
  return { ok: true, fullscreen: false };
}

// Pause or resume the recording (the meeting went off topic, a private call, a break). While paused the recorder puts
// silence on both streams: nothing is transcribed, fingerprinted or kept, and times stay right. The pauses are noted
// on the meeting so the transcript can say so.
async function setPaused(want) {
  let changed = false;
  const now = Date.now();
  await mutateState((st) => {
    if (!st.recording || st.stopping) return null;
    const on = typeof want === 'boolean' ? want : !st.paused;
    if (on === !!st.paused) return null;
    changed = true;
    return { ...st, paused: on, pausedAt: on ? now : null };
  });
  const st = await getState();
  if (!changed || !st.recording) return { ok: true, paused: !!st.paused };
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'pause', on: !!st.paused }).catch(() => {});
  const sec = Math.max(0, Math.round((now - st.startedAt) / 1000));
  await updateMeetingMeta(st.meetingId, (m) => {
    const list = (m.pauses ||= []);
    if (st.paused) list.push({ from: sec, to: null });
    else if (list.length && list.at(-1).to == null) list.at(-1).to = sec;
  });
  if (!rec) showRec(st.tabId, st.startedAt, !!st.alert); // the worker restarted while recording
  rec.paused = !!st.paused;
  paintRec();
  broadcast(st.meetingId, 'state', liveState(st));
  // a quiet stretch while paused must not trip the silence safety stop
  await chrome.storage.session.set({ quietSince: now });
  return { ok: true, paused: !!st.paused };
}

// Opt-in: learn who is who from this meeting's captions and voice fingerprints (see voice/learn.js).
// Always leaves a trace on the meeting (a report, "off", or the error), so "no voices to name" can say why. Safe to run again
// later from the minutes page: a voice already learned from this meeting is not counted twice.
async function learnVoices(meetingId) {
  let step = 'reading settings';
  try {
    const s = await getSettings();
    const m = await getMeeting(meetingId);
    if (!m) return { ok: false, error: 'meeting not found' };
    if (!s.voiceLearn) {
      await saveSamples(meetingId, null, []).catch(() => {}); // only clears waiting audio
      await patchMeeting(meetingId, { voiceLearn: { off: true } });
      return { ok: true, off: true };
    }
    step = 'reading the blocked voices';
    const blocked = await getBlockedVoices();
    step = 'matching the voices';
    const r = learnFromMeeting(m, s.voices || [], { myName: s.myName, blocked });
    const r2 = learnRecurring(m, r.list, { blocked });
    step = 'saving the voices';
    const typedAt = findTyped(r2.list); // should never happen; if it does, the note says where, and the list is cleaned on saving
    if (r.changed || r2.changed) await saveVoices(r2.list);
    // keep one short clip per unnamed voice (if switched on), and always delete the waiting audio
    step = 'keeping the audio clips';
    await saveSamples(meetingId, s.voiceSamples ? m : null, r2.list).catch(() => {});
    step = 'saving the result in the meeting';
    await patchMeeting(meetingId, { voiceLearn: plain({ ...r.report, recurring: r2.report }) });
    await appendMeeting(meetingId, 'debug', [
      ...(typedAt ? [`voice learning: a typed array was found at voices.${typedAt} and converted`] : []),
      `voice learning: ${r2.report.created.length} new, ${r2.report.updated.length + r.report.learned.length} updated, from ${(m.voiceSegs || []).length} pieces`,
    ]);
    return { ok: true, created: r2.report.created.length };
  } catch (e) {
    await patchMeeting(meetingId, { voiceLearn: { error: `${String(e?.message || e)} (while ${step})` } }).catch(() => {});
    await note(meetingId, `voice learning failed while ${step}: ${e?.message || e}`).catch(() => {});
    return { ok: false, error: String(e?.message || e) };
  }
}

let stopping = null;
function stop(opts = {}) {
  // Popup click, tab close, and track-ended can all fire; only stop once.
  stopping ||= (async () => {
    let st;
    await mutateState((cur) => {
      st = cur;
      return cur.recording && !cur.stopping ? { ...cur, stopping: true } : null;
    });
    if (!st?.recording) return { ok: true };
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    } catch {}
    if (opts.discard) {
      // an accidental recording: nothing is kept, nothing is transcribed, no minutes, no email
      if (pres?.id === st.meetingId) {
        clearTimeout(pres.timer);
        pres = null;
      }
      await deleteMeeting(st.meetingId).catch(() => {});
      await mutateState(() => ({ recording: false }));
      hideRec(st.tabId);
      broadcast(st.meetingId, 'state', liveState({ startedAt: st.startedAt }));
      return { ok: true, discarded: true };
    }
    await endPresence(st.meetingId).catch(() => {});
    await updateMeetingMeta(st.meetingId, (m) => {
      m.endedAt = Date.now();
      const open = (m.pauses || []).at(-1); // stopped while paused: the pause ends with the meeting
      if (open && open.to == null) open.to = Math.round((m.endedAt - m.startedAt) / 1000);
    });
    await learnVoices(st.meetingId).catch(() => {});
    // the minutes (and the automatic email) are written in the background; the offscreen document closes itself when done
    await startJob(st.meetingId).catch(() => {});
    await mutateState(() => ({ recording: false }));
    hideRec(st.tabId);
    broadcast(st.meetingId, 'state', liveState({ startedAt: st.startedAt }));
    // After an automatic stop, open the minutes in the background so it doesn't pull you out of what you're doing.
    await chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${st.meetingId}`), active: !opts.background });
    return { ok: true };
  })().finally(() => (stopping = null));
  return stopping;
}

// Effective mic = what the user wants, unless "follow Meet mute" is on and Meet itself is muted.
async function applyMic(patch = {}) {
  const { followMeetMute } = await getSettings();
  let eff = false;
  let changed = false;
  let cur = null;
  let noted = '';
  await mutateState((st) => {
    if (!st.recording || st.stopping) return null;
    cur = { ...st, ...patch };
    if ('meetMuted' in patch && patch.meetMuted !== st.meetMuted) noted = `Meet mic: ${patch.meetMuted === true ? 'muted' : patch.meetMuted === false ? 'unmuted' : 'state not detected'} at +${Math.round((Date.now() - (st.startedAt || Date.now())) / 1000)}s${followMeetMute ? '' : ' (following Meet is off)'}`;
    // in a room the microphone is the meeting, whatever Meet says about being muted
    eff = !!cur.micWanted && !!cur.mic && !(followMeetMute && !cur.room && cur.meetMuted === true);
    changed = eff !== !!st.micOn;
    return cur;
  });
  if (!cur) return { ok: false };
  if (noted && cur.meetingId) note(cur.meetingId, `${noted}; Debrief mic ${eff ? 'on' : 'off'}`).catch(() => {});
  let micOn = cur.micOn;
  if (changed) {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'mic', on: eff }).catch(() => null);
    micOn = r?.micOn ?? false;
    await mutateState((st) => (st.recording && !st.stopping ? { ...st, micOn } : null));
  }
  return { ok: true, micOn, micWanted: !!cur.micWanted };
}

// Stops the recording because the meeting is over, and says so.
async function autoStop(reason) {
  const st = await getState();
  if (!st.recording || st.stopping) return;
  await note(st.meetingId, `auto-stop: ${reason}`);
  await stop({ background: true });
  notify('debrief-autostop', { title: 'Debrief stopped recording', message: `${reason} Writing the minutes now.` });
}

// What a page script (running on a meeting site) may ask for. Everything else must come from Debrief's own pages.
export const PAGE_MAY = new Set(['window-fullscreen', 'whoami', 'meet-mute', 'meet-ended', 'meet-snap', 'in-call', 'pill-state', 'mic', 'stop', 'discard', 'set-follow', 'dismiss-alert', 'pause', 'notice-result', 'presenting', 'nudge-dismiss', 'set-nudge']);
// ...and of those, the ones that change the recording: only from the tab being recorded (another meeting tab, or a
// second meeting site open beside it, must not stop, discard or unmute it).
export const RECORDED_TAB_ONLY = new Set(['mic', 'stop', 'discard', 'set-follow', 'dismiss-alert', 'pause', 'meet-mute']);

// Who sent a message. A content script has sender.tab and the URL of the page (or frame) it runs in. Debrief's own pages
// have a chrome-extension:// URL of this extension: in a tab of their own, as the floating panel's frame inside a page
// (sender.tab set too) or with no tab at all (the offscreen document, the popup). The URL is set by Chrome, not the page.
export const isOwnPage = (sender, base = chrome.runtime.getURL('')) => !sender?.tab || String(sender?.url || '').startsWith(base);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'bg') return;
  if (sender.id !== chrome.runtime.id) return;
  const ownPage = isOwnPage(sender);
  if (!ownPage && !PAGE_MAY.has(msg.type)) return;
  const handlers = {
    start: () => start(msg),
    stop: () => stop(),
    discard: () => stop({ discard: true }),
    // Full screen for the whole browser window. Chrome keeps a tab that is being captured from taking the window full
    // screen when the page asks (Meet's "Full screen" button), so Debrief does it through the window itself. A page
    // sets `auto` when it only follows its own full screen: then Debrief only undoes what it did itself.
    'window-fullscreen': () => setWindowFullscreen(sender.tab?.windowId, typeof msg.on === 'boolean' ? msg.on : undefined, !!msg.auto),
    mic: () => applyMic({ micWanted: !!msg.on }),
    pause: () => setPaused(typeof msg.on === 'boolean' ? msg.on : undefined),
    'mic-refresh': () => applyMic(),
    'meet-mute': () => (typeof msg.muted === 'boolean' || msg.muted === null ? applyMic({ meetMuted: msg.muted }) : Promise.resolve({ ok: false })),
    whoami: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
    level: async () => {
      await chrome.storage.session.set({ levels: { tab: msg.tab, mic: msg.mic, ctx: msg.ctx, at: Date.now() } });
      // Safety net: sound was heard earlier, and now nobody (you included) has made one for a long time.
      const now = Date.now();
      if (Math.max(msg.tab || 0, msg.mic || 0) >= 0.012) {
        await chrome.storage.session.set({ quietSince: now, heard: true });
        return;
      }
      if ((await getState()).paused) return; // paused on purpose: not a silent meeting
      const { quietSince, heard } = await chrome.storage.session.get(['quietSince', 'heard']);
      if (!heard || !quietSince) return;
      const s = await getSettings();
      const mins = Number(s.autoStopQuietMin);
      if (s.autoStop !== false && mins > 0 && now - quietSince > mins * 60000) await autoStop(`It was silent for ${mins} minutes.`);
    },
    'meet-ended': async () => {
      const st = await getState();
      if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
      if ((await getSettings()).autoStop === false) return { ok: false };
      await autoStop('The meeting ended.');
      return { ok: true };
    },
    'mic-silent': () => raiseAlert(msg.meetingId, 'MIC_SILENT'),
    // the minutes page asks for this when voice learning left no trace for a meeting that has voice pieces
    'learn-voices': () => learnVoices(msg.id),
    'job-run': () => jobCommand('job-run', { id: msg.id, force: !!msg.force, reread: !!msg.reread }),
    'job-hold': () => jobCommand('job-hold', { id: msg.id }, { create: false }),
    'job-abort': () => jobCommand('job-abort', { id: msg.id }, { create: false }),
    'offscreen-idle': async () => {
      if (!(await getState()).recording) await closeOffscreen();
      return { ok: true };
    },
    notify: async () => {
      notify(String(msg.id || 'debrief'), { title: String(msg.title || 'Debrief'), message: String(msg.message || '') });
      return { ok: true };
    },
    // the offscreen document has no chrome.storage, so the job runner reads and writes through here
    store: async () => {
      if (msg.op === 'settings') return { ok: true, value: await getSettings() };
      if (msg.op === 'getMeeting') return { ok: true, value: await getMeeting(msg.id) };
      if (msg.op === 'listMeetingMetas') return { ok: true, value: await listMeetingMetas(msg.opts || {}) };
      if (msg.op === 'getMeetingMeta') return { ok: true, value: await getMeetingMeta(msg.id, msg.opts || (msg.counts ? { counts: msg.counts } : undefined)) };
      // a copy sent from there carries what it held when read as `__loaded` (jobs.js useStore), so only its changes are written
      if (msg.op === 'saveMeeting') return (await saveMeeting(msg.meeting), { ok: true });
      if (msg.op === 'patchMeeting') return { ok: true, value: await patchMeeting(msg.id, msg.fields || {}) };
      if (msg.op === 'appendMeeting') return { ok: true, value: await appendMeeting(msg.id, msg.list, msg.items || []) };
      // the minutes and the action ticks in one update under the lock, so a tick made while the model was writing is kept
      if (msg.op === 'saveMinutes') return { ok: true, value: await updateMeetingMeta(msg.id, (m) => Object.assign(m, msg.fields?.items ? { ...msg.fields, items: keepStatuses(msg.fields.items, m.items) } : msg.fields || {})) };
      // an action ticked, or a carried action closed by a later meeting: read and write under the meeting's lock
      if (msg.op === 'setActionStatus') {
        let found = false;
        const r = await updateMeetingMeta(msg.id, (m) => {
          const next = tickItems(m.items, msg.actionId, msg.status === 'done');
          if (next) [found, m.items] = [true, next];
        });
        return { ok: true, value: r !== null && found };
      }
      if (msg.op === 'applyReview')
        return {
          ok: true,
          value: await updateMeetingMeta(msg.id, (m) => {
            const next = reviewItems(m.items, Array.isArray(msg.done) ? msg.done : [], msg.by);
            if (next) m.items = next;
          }),
        };
      // today's request counts and learned limits, so screen notes can leave room for the minutes
      if (msg.op === 'usage') return { ok: true, value: await chrome.storage.local.get(['usage', 'learnedLimits']) };
      if (msg.op === 'mergeEmailNames') return { ok: true, value: await mergeEmailNames(msg.found) };
      if (msg.op === 'emailNames') return { ok: true, value: await getEmailNames() };
      return { ok: false };
    },
    dbg: async () => void (await note(msg.meetingId, msg.note)),
    segment: async () => {
      await appendMeeting(msg.meetingId, 'segments', [msg.seg]);
      broadcast(msg.meetingId, 'segment', msg.seg);
      await clearAlert();
    },
    // A note about the shared screen, written by the recorder. A page script never sends this (not in PAGE_MAY).
    'screen-note': async () => {
      const n = msg.note;
      const okNote = n && typeof n === 'object' && Number.isFinite(n.t) && n.t >= 0 && typeof n.text === 'string' && n.text.trim().length >= 1 && n.text.length <= 600 && (n.presenter === null || n.presenter === undefined || (typeof n.presenter === 'string' && n.presenter.length <= 60));
      if (!okNote || typeof msg.meetingId !== 'string') return { ok: false };
      const item = { t: n.t, text: n.text, presenter: n.presenter ?? null };
      const m = await getMeetingMeta(msg.meetingId, { counts: ['screens'] });
      if (!m || m.counts.screens >= SCREEN_NOTES_MAX) return { ok: false };
      await appendMeeting(msg.meetingId, 'screens', [item], { limit: SCREEN_NOTES_MAX });
      broadcast(msg.meetingId, 'screen', item);
      return { ok: true };
    },
    // the live transcript page asks which meeting is being recorded
    'live-state': async () => {
      const st = await getState();
      return { ok: true, rec: st, meetingId: st.recording ? st.meetingId : null };
    },
    // The pill tried to post the recording notice in the meeting chat. The first result is kept (a reload must not post twice).
    'notice-result': async () => {
      const st = await getState();
      if (!st.recording || st.stopping || sender.tab?.id !== st.tabId) return { ok: false };
      if (typeof msg.ok !== 'boolean' || (msg.posted != null && typeof msg.posted !== 'boolean') || (msg.why != null && typeof msg.why !== 'string')) return { ok: false };
      const out = { ok: msg.ok, posted: !!msg.posted, why: String(msg.why || '').slice(0, 120), at: Date.now() };
      let first = false;
      await updateMeetingMeta(st.meetingId, (m) => {
        if (!m.notice) {
          m.notice = out;
          first = true;
        }
      });
      if (first) await note(st.meetingId, `chat notice: ${out.posted ? 'posted' : out.ok ? 'not needed' : 'failed'}${out.why ? ` (${out.why})` : ''}`);
      return { ok: true, first };
    },
    // Someone is presenting (or stopped): the recorder describes the shared screen only while that is so.
    presenting: async () => {
      const st = await getState();
      if (!st.recording || st.stopping || sender.tab?.id !== st.tabId) return { ok: false };
      if (typeof msg.on !== 'boolean' || (msg.name != null && (typeof msg.name !== 'string' || msg.name.length > 60))) return { ok: false };
      let name = msg.on && msg.name ? msg.name.replace(/\s+/g, ' ').trim() || null : null;
      const me = (await getSettings()).myName;
      if (name && /^you$/i.test(name) && me) name = me;
      await Promise.resolve(chrome.runtime.sendMessage({ target: 'offscreen', type: 'presenting', on: msg.on, name })).catch(() => {});
      return { ok: true };
    },
    // "Not now" on the record reminder (key stored for this browser session, last 50), or the page saying it raised the reminder
    // while its tab was hidden (`notified`): then a system notification goes out once per call.
    'nudge-dismiss': () =>
      serial(async () => {
        const key = msg.key;
        if (typeof key !== 'string' || !key || key.length > 200) return { ok: false };
        const name = msg.notified === true ? 'nudgeNotified' : 'nudgeDismissed';
        const list = (await chrome.storage.session.get(name))[name] || [];
        if (msg.notified === true && list.includes(key)) return { ok: true, notified: false };
        await chrome.storage.session.set({ [name]: [...list.filter((k) => k !== key), key].slice(-50) });
        if (msg.notified !== true) return { ok: true };
        if ((await getSettings()).recordNudge === false || (await getState()).recording) return { ok: true, notified: false };
        // No meeting title here: notifications can show on a shared screen.
        notify('debrief-nudge', { title: 'Debrief: record this meeting?', message: `A call that matches one of your meeting types is on. Click the Debrief button or press ${await shortcutText()} to record.` });
        return { ok: true, notified: true };
      }),
    'set-nudge': async () => {
      if (typeof msg.on !== 'boolean') return { ok: false };
      await setSetting({ recordNudge: msg.on });
      return { ok: true };
    },
    'stt-error': async () => {
      await appendMeeting(msg.meetingId, 'errors', [msg.error]);
      await raiseAlert(msg.meetingId, msg.error);
    },
    // a stretch the speech-to-text answered with far too little text, even after it was read again in parts (see coverage.js)
    gap: async () => void (await appendMeeting(msg.meetingId, 'gaps', [msg.gap])),
    silence: async () => void (await appendMeeting(msg.meetingId, 'silences', [{ t: msg.t, dur: msg.dur }], { limit: CAPS.silences })),
    usage: () =>
      serial(async () => {
        const { usage, learnedLimits = {} } = await chrome.storage.local.get(['usage', 'learnedLimits']);
        const next = { usage: addEntry(usage, msg.entry) };
        if (msg.entry?.learned) next.learnedLimits = { ...learnedLimits, [msg.entry.learned.model]: msg.entry.learned.limit };
        await chrome.storage.local.set(next);
      }),
    // People and captions sampled from the meeting page: who was there when, and who spoke.
    'meet-snap': async () => {
      const st = await getState();
      if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
      const me = (await getSettings()).myName;
      // names come from the page: text only, short, and few
      const who = (n) => String(/^you$/i.test(n) && me ? me : n ?? '').slice(0, NAME_MAX);
      const names = (Array.isArray(msg.names) ? msg.names : []).filter((x) => typeof x === 'string' && !isIconText(x) && !isMenuText(x)).slice(0, NAMES_MAX);
      if (names.length) {
        // Someone absent from this sample may just be off-screen, so only the last time seen of those present is extended.
        const p = await presenceFor(st.meetingId);
        for (const n of names) {
          const k = who(n);
          if (!k) continue;
          const v = p.map[k];
          if (!v && Object.keys(p.map).length >= NAMES_MAX) continue;
          if (v) {
            v[1] = msg.t;
            v[2] = (v[2] || 0) + 1;
          } else p.map[k] = [msg.t, msg.t, 1];
        }
        await presenceChanged(p);
      }
      const incoming = (Array.isArray(msg.captions) ? msg.captions : []).filter((c) => c && typeof c.text === 'string');
      // A caption that grows (Meet rewrites the current sentence as it is heard) replaces its earlier version when that is
      // among the last 40 lines of the newest chunk; otherwise it is a new line. Only that chunk is rewritten.
      if (incoming.length)
        await editMeetingTail(st.meetingId, 'captions', (caps) => {
          for (const c of incoming) {
            const name = who(c.name);
            let last = null;
            for (let i = caps.length - 1; i >= 0 && i > caps.length - 40; i--) if (caps[i].name === name) {
              last = caps[i];
              break;
            }
            if (last && c.t - last.t2 < 15 && (c.text.startsWith(last.text) || last.text.startsWith(c.text) || last.text.slice(0, 20) === c.text.slice(0, 20))) {
              last.text = c.text.length >= last.text.length ? c.text : last.text;
              last.t2 = c.t;
            } else caps.push({ t: c.t, t2: c.t, name, text: c.text });
          }
        }, { max: CAPS.captions, look: 40 }); // look: a line whose earlier version sits at the end of the previous chunk grows there
      return { ok: true };
    },
    // A page script saw a live call (or the call ended): glow the icon amber unless we are already recording it.
    'in-call': async () => {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false };
      const st = await getState();
      if (st.recording && st.tabId === tabId) return { ok: true };
      if (msg.on) showCallOn(tabId);
      else showCallOff(tabId);
      return { ok: true };
    },
    // Voice fingerprints of the meeting's speech, made by the recorder. Only fingerprints, never audio.
    'voice-seg': async () => {
      const segs = (msg.segs || []).filter((x) => Number.isFinite(x?.t0) && Number.isFinite(x?.t1) && typeof x.e === 'string' && x.e.length < 600).map((x) => ({ t0: x.t0, t1: x.t1, e: x.e, ...(x.s === 'm' ? { s: 'm' } : {}) })).slice(0, 200);
      if (!segs.length) return { ok: false };
      if (!voiceModelSet.has(msg.meetingId)) {
        await patchMeeting(msg.meetingId, { voiceModel: 'wespeaker-resnet34-lm' });
        voiceModelSet.add(msg.meetingId);
      }
      await appendMeeting(msg.meetingId, 'voiceSegs', segs, { max: CAPS.voiceSegs });
      return { ok: true };
    },
    'dismiss-alert': () => clearAlert(),
    'set-follow': async () => {
      await setSetting({ followMeetMute: !!msg.on });
      return applyMic();
    },
    // The minutes job (offscreen document, which has no permissions API) asks for the webhook post. Only the meeting id
    // comes from the message: the address and the minutes are read here, and nothing is sent without Chrome's permission.
    'webhook-post': async () => {
      if (typeof msg.meetingId !== 'string' || !msg.meetingId) return { ok: false, status: 0, error: 'No meeting.' };
      const [s, m] = await Promise.all([getSettings(), getMeeting(msg.meetingId)]);
      if (!m) return { ok: false, status: 0, error: 'The meeting was not found.' };
      return postIfPermitted(m, s);
    },
    'pill-state': async () => {
      const s = await getSettings();
      const rec = await getState();
      const { levels } = await chrome.storage.session.get('levels');
      // asked about once a second: the counts come from META and the last chunk, never the whole transcript
      const m = rec.meetingId ? await getMeetingMeta(rec.meetingId, { counts: ['segments', 'errors'] }) : null;
      const nudgeOn = s.recordNudge !== false;
      const text = typeof s.consentText === 'string' ? s.consentText.trim().slice(0, 300) : '';
      const { nudgeDismissed = [] } = await chrome.storage.session.get('nudgeDismissed');
      return {
        ok: true,
        rec,
        levels: levels || null,
        counts: { segs: m?.counts.segments || 0, errs: m?.counts.errors || 0 },
        follow: s.followMeetMute !== false,
        showPill: s.pillOnPage === true,
        screenNotes: s.screenNotes === true, // the page only looks for who is presenting when this is on
        captionMode: s.meetCaptions || 'read',
        otherSites: s.otherSites !== false,
        shortcut: await shortcutText(),
        // the recording notice for the meeting chat; done = a result is already kept, so a reload never posts twice
        notice: { on: s.consentNotice === true && !!text, text, done: !!m?.notice },
        // only what the record reminder needs to match a call against the user's meeting types
        nudge: {
          on: nudgeOn,
          skipOneOnOne: s.nudgeSkipOneOnOne !== false,
          meetingTypes: nudgeOn ? (Array.isArray(s.meetingTypes) ? s.meetingTypes : []).slice(0, 50).map((t) => ({ id: String(t?.id ?? ''), name: String(t?.name ?? ''), match: String(t?.match ?? ''), code: String(t?.code ?? '') })) : [],
          dismissed: nudgeDismissed,
        },
      };
    },
  };
  let h = handlers[msg.type];
  if (!h) return;
  if (!ownPage && RECORDED_TAB_ONLY.has(msg.type)) {
    const run = h;
    h = async () => {
      const st = await getState();
      if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
      return run();
    };
  }
  h().then(
    (r) => sendResponse(r ?? { ok: true }),
    (e) => sendResponse({ ok: false, error: e.message })
  );
  return true;
});

// Keyboard shortcut (Alt+Shift+M by default): start recording the current tab, or stop.
// A command counts as invoking the extension, so tab capture is allowed without the popup.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-fullscreen') {
    await setWindowFullscreen(tab?.windowId);
    return;
  }
  if (command === 'toggle-pause') {
    if ((await getState()).recording) await setPaused();
    return;
  }
  if (command === 'toggle-mic') {
    const cur = await getState();
    if (cur.recording) await applyMic({ micWanted: !(cur.micWanted ?? cur.micOn) });
    return;
  }
  if (command !== 'toggle-recording') return;
  const st = await getState();
  if (st.recording) return stop();
  if (!tab?.id) return;
  if (!sttReady(await getSettings())) return chrome.runtime.openOptionsPage();
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const r = await start({ streamId, tabId: tab.id, title: tab.title, url: tab.url });
    if (!r.ok) throw new Error(r.error);
  } catch (e) {
    stopGlow(tab.id);
    setBadge(tab.id, '!', '#1d1f24');
    setTip(tab.id, `${TIP_ATTN}: could not start (${e.message})`);
  }
});

// Reminder: an amber dot on the icon while a Meet call tab is open and not being recorded.
const MEET_CALL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#]|$)/;
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const st = await getState();
  if (st.recording && st.tabId === tabId) return;
  if (MEET_CALL.test(tab.url || '')) showCallOn(tabId);
});

// Leaving the call page (or the whole meeting site) also ends the recording.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const st = await getState();
  if (!st.recording || st.stopping || tabId !== st.tabId || !st.meetCode) return;
  if (info.url.includes(st.meetCode)) return;
  if ((await getSettings()).autoStop === false) return;
  await autoStop('You left the meeting page.');
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  glowTabs.delete(tabId);
  endGlowTimer();
  const st = await getState();
  if (st.recording && st.tabId === tabId) stop();
});

// ---- Floating glass panel (src/panel.js) instead of Chrome's popup window, on pages that allow it ----
// Setting uiPanel (Settings > Appearance, on by default). With no popup set, a click on the toolbar button fires
// action.onClicked and the panel is injected into the page (activeTab covers it). Pages that cannot be scripted
// (chrome://, the web store, the new-tab page, PDFs in the viewer) keep the ordinary popup, set per tab.
const canPanel = (url) => /^(https?|file):/i.test(url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
let panelOn = true;
async function setPopupFor(tabId, url) {
  if (tabId == null) return;
  await quiet(chrome.action.setPopup({ tabId, popup: panelOn && canPanel(url) ? '' : 'popup.html' }));
}
async function applyPanelMode() {
  const r = await chrome.storage.local.get('uiPanel').catch(() => ({}));
  panelOn = r.uiPanel !== false;
  await quiet(chrome.action.setPopup({ popup: panelOn ? '' : 'popup.html' }));
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) await setPopupFor(t.id, t.url);
}
applyPanelMode();
chrome.runtime.onStartup?.addListener(applyPanelMode);
chrome.runtime.onInstalled.addListener(applyPanelMode);
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && 'uiPanel' in c) applyPanelMode();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'loading') setPopupFor(tabId, info.url || tab.url);
});
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then((t) => setPopupFor(tabId, t.url)).catch(() => {}));

async function openPlainPopup(tabId, windowId) {
  await quiet(chrome.action.setPopup({ tabId, popup: 'popup.html' }));
  await quiet(chrome.action.openPopup({ windowId }));
}
chrome.action.onClicked.addListener(async (tab) => {
  if (!canPanel(tab.url)) return openPlainPopup(tab.id, tab.windowId);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/panel.js'] });
  } catch {
    await openPlainPopup(tab.id, tab.windowId);
  }
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.target === 'bg' && msg.type === 'panel-failed' && sender.tab) openPlainPopup(sender.tab.id, sender.tab.windowId);
});
