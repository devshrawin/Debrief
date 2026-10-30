import { isIconText, isMenuText } from './iconText.js';
import { learnFromMeeting, learnRecurring } from './voice/learn.js';
import { roomFor } from './room.js';
import { saveSamples } from './voice/sampling.js';
import { classifyError } from './alerts.js';
import { MEET_CODE } from './meetend.js';
import { addEntry } from './usage.js';
import { stuckJobs } from './jobstate.js';
import { getSettings, setSetting, sttReady, getMeeting, saveMeeting, deleteMeeting, addMeetingId, getState, setState, saveVoices, plain, findTyped, getBlockedVoices, getEmailNames, mergeEmailNames } from './store.js';

// Meeting records are read-modify-written from several messages; run those one at a time.
// First install: show the guided tour. (Updates stay quiet; the popup has a Take the tour link.)
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.storage.local.set({ schema: 2 }); // a new install starts generic: nothing to migrate
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
const setBadge = (tabId, text, color) => {
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
  if (glowTabs.has(tabId)) return;
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

async function updateMeeting(id, fn) {
  return serial(async () => {
    const m = await getMeeting(id);
    if (!m) return;
    fn(m);
    await saveMeeting(m);
  });
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
    chrome.notifications?.create(`debrief-${a.kind}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `Debrief: ${a.title}`,
      message: a.detail,
      priority: 2,
    });
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
  await updateMeeting(id, (m) => {
    m.job = { state: 'queued', beat: Date.now(), error: null };
  });
  return jobCommand('job-run', { id });
}

// After a restart (or when the service worker wakes), jobs that were running and have no runner any more are picked up.
async function resumeJobs() {
  const { meetingIds = [] } = await chrome.storage.local.get('meetingIds');
  const rows = await chrome.storage.local.get(meetingIds.slice(0, 30).map((i) => `meeting:${i}`));
  for (const id of stuckJobs(Object.values(rows))) await jobCommand('job-run', { id, resume: true });
}
resumeJobs().catch(() => {});
chrome.runtime.onStartup?.addListener(() => resumeJobs().catch(() => {}));

const cleanTitle = (t = '') => t.replace(/^Meet\s*[-–]\s*/i, '').replace(/\s*[-–]\s*Google Meet$/i, '').trim() || 'Meeting';

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
  await addMeetingId(id);

  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: msg.streamId, settings: { ...settings, roomMode: room, captureMic: settings.captureMic || room }, meetingId: id }).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    await closeOffscreen();
    await updateMeeting(id, (m) => {
      m.endedAt = Date.now();
      m.errors.push(`Start failed: ${r?.error}`);
    });
    return { ok: false, error: r?.error || 'Recorder did not start.' };
  }
  await mutateState(() => ({ recording: true, room, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null, meetCode: (msg.url || '').match(MEET_CODE)?.[0] || null }));
  // The silence timer only starts once sound has been heard, so a quiet lobby never ends the recording.
  await chrome.storage.session.set({ quietSince: null, heard: false });
  // The pill is a content script; inject it now so it appears without reloading the Meet tab.
  chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['dist/pill.js'] }).catch(() => {});
  // A tab-specific badge (the Meet reminder) would hide the global one on that tab, so showRec sets both.
  showRec(msg.tabId, Date.now());
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
  await updateMeeting(st.meetingId, (m) => {
    const list = (m.pauses ||= []);
    if (st.paused) list.push({ from: sec, to: null });
    else if (list.length && list.at(-1).to == null) list.at(-1).to = sec;
  });
  if (!rec) showRec(st.tabId, st.startedAt, !!st.alert); // the worker restarted while recording
  rec.paused = !!st.paused;
  paintRec();
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
      await updateMeeting(meetingId, (mm) => {
        mm.voiceLearn = { off: true };
      });
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
    await updateMeeting(meetingId, (mm) => {
      mm.voiceLearn = plain({ ...r.report, recurring: r2.report });
      if (typedAt) (mm.debug ||= []).push(`voice learning: a typed array was found at voices.${typedAt} and converted`);
      (mm.debug ||= []).push(`voice learning: ${r2.report.created.length} new, ${r2.report.updated.length + r.report.learned.length} updated, from ${(m.voiceSegs || []).length} pieces`);
    });
    return { ok: true, created: r2.report.created.length };
  } catch (e) {
    await updateMeeting(meetingId, (mm) => {
      mm.voiceLearn = { error: `${String(e?.message || e)} (while ${step})` };
      (mm.debug ||= []).push(`voice learning failed while ${step}: ${e?.message || e}`);
    }).catch(() => {});
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
      await deleteMeeting(st.meetingId).catch(() => {});
      await mutateState(() => ({ recording: false }));
      hideRec(st.tabId);
      return { ok: true, discarded: true };
    }
    await updateMeeting(st.meetingId, (m) => {
      m.endedAt = Date.now();
      const open = (m.pauses || []).at(-1); // stopped while paused: the pause ends with the meeting
      if (open && open.to == null) open.to = Math.round((m.endedAt - m.startedAt) / 1000);
    });
    await learnVoices(st.meetingId).catch(() => {});
    // the minutes (and the automatic email) are written in the background; the offscreen document closes itself when done
    await startJob(st.meetingId).catch(() => {});
    await mutateState(() => ({ recording: false }));
    hideRec(st.tabId);
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
  if (noted && cur.meetingId) updateMeeting(cur.meetingId, (m) => (m.debug ||= []).push(`${noted}; Debrief mic ${eff ? 'on' : 'off'}`)).catch(() => {});
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
  await updateMeeting(st.meetingId, (m) => (m.debug ||= []).push(`auto-stop: ${reason}`));
  await stop({ background: true });
  chrome.notifications?.create('debrief-autostop', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Debrief stopped recording',
    message: `${reason} Writing the minutes now.`,
  });
}

// What a page script (running on a meeting site) may ask for. Everything else must come from Debrief's own pages.
const PAGE_MAY = new Set(['window-fullscreen', 'whoami', 'meet-mute', 'meet-ended', 'meet-snap', 'in-call', 'pill-state', 'mic', 'stop', 'discard', 'set-follow', 'dismiss-alert']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'bg') return;
  if (sender.id !== chrome.runtime.id) return;
  const ownPage = !sender.tab || (sender.url || '').startsWith(chrome.runtime.getURL(''));
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
    'meet-mute': () => applyMic({ meetMuted: msg.muted }),
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
      chrome.notifications?.create(String(msg.id || 'debrief'), { type: 'basic', iconUrl: 'icons/icon128.png', title: String(msg.title || 'Debrief'), message: String(msg.message || '') });
      return { ok: true };
    },
    // the offscreen document has no chrome.storage, so the job runner reads and writes through here
    store: async () => {
      if (msg.op === 'settings') return { ok: true, value: await getSettings() };
      if (msg.op === 'getMeeting') return { ok: true, value: await getMeeting(msg.id) };
      if (msg.op === 'saveMeeting') return serial(async () => (await saveMeeting(msg.meeting), { ok: true }));
      if (msg.op === 'patchMeeting') return { ok: true, value: await updateMeeting(msg.id, (m) => Object.assign(m, msg.fields)) };
      if (msg.op === 'mergeEmailNames') return { ok: true, value: await mergeEmailNames(msg.found) };
      if (msg.op === 'emailNames') return { ok: true, value: await getEmailNames() };
      return { ok: false };
    },
    dbg: () => updateMeeting(msg.meetingId, (m) => (m.debug ||= []).push(msg.note)),
    segment: async () => {
      await updateMeeting(msg.meetingId, (m) => m.segments.push(msg.seg));
      await clearAlert();
    },
    'stt-error': async () => {
      await updateMeeting(msg.meetingId, (m) => m.errors.push(msg.error));
      await raiseAlert(msg.meetingId, msg.error);
    },
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
      const who = (n) => (/^you$/i.test(n) && me ? me : n);
      await updateMeeting(st.meetingId, (m) => {
        const pres = (m.presence ||= {});
        for (const n of (msg.names || []).filter((x) => !isIconText(x) && !isMenuText(x))) {
          const k = who(n);
          const p = pres[k];
          if (p) {
            p[1] = msg.t;
            p[2] = (p[2] || 0) + 1;
          } else pres[k] = [msg.t, msg.t, 1];
        }
        if (msg.names) {
          // Someone absent from this sample may just be off-screen, so only the last time seen is extended.
        }
        const caps = (m.captions ||= []);
        for (const c of msg.captions || []) {
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
        if (caps.length > 4000) caps.splice(0, caps.length - 4000);
      });
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
      await updateMeeting(msg.meetingId, (m) => {
        const all = (m.voiceSegs ||= []);
        all.push(...segs);
        m.voiceModel = 'wespeaker-resnet34-lm';
        if (all.length > 12000) all.splice(0, all.length - 12000);
      });
      return { ok: true };
    },
    'dismiss-alert': () => clearAlert(),
    'set-follow': async () => {
      await setSetting({ followMeetMute: !!msg.on });
      return applyMic();
    },
    'pill-state': async () => {
      const rec = await getState();
      const { levels } = await chrome.storage.session.get('levels');
      const m = rec.meetingId ? await getMeeting(rec.meetingId) : null;
      return { ok: true, rec, levels: levels || null, counts: { segs: m?.segments.length || 0, errs: m?.errors.length || 0 }, follow: (await getSettings()).followMeetMute !== false, showPill: (await getSettings()).pillOnPage === true, captionMode: (await getSettings()).meetCaptions || 'read', otherSites: (await getSettings()).otherSites !== false };
    },
  };
  const h = handlers[msg.type];
  if (!h) return;
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
let sideOn = false; // Settings > Appearance > Chrome's side panel (uiSide, off by default)
async function setPopupFor(tabId, url) {
  if (tabId == null) return;
  await quiet(chrome.action.setPopup({ tabId, popup: sideOn || (panelOn && canPanel(url)) ? '' : 'popup.html' }));
}
async function applyPanelMode() {
  const r = await chrome.storage.local.get(['uiPanel', 'uiSide']).catch(() => ({}));
  panelOn = r.uiPanel !== false;
  sideOn = r.uiSide === true;
  await quiet(chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: sideOn }));
  await quiet(chrome.action.setPopup({ popup: sideOn || panelOn ? '' : 'popup.html' }));
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) await setPopupFor(t.id, t.url);
}
applyPanelMode();
chrome.runtime.onStartup?.addListener(applyPanelMode);
chrome.runtime.onInstalled.addListener(applyPanelMode);
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && ('uiPanel' in c || 'uiSide' in c)) applyPanelMode();
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
  if (sideOn) return; // the browser opens the side panel itself
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
