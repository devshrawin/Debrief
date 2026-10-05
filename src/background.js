import { classifyError } from './alerts.js';
import { getSettings, saveSettings, sttReady, getMeeting, saveMeeting, addMeetingId, getState, setState } from './store.js';

// Meeting records are read-modify-written from several messages; run those one at a time.
// The on-page Meet pill reads recorder state, so let content scripts see session storage.
chrome.storage.session.setAccessOptions?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

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
  const st = await getState();
  if (!st.recording) return;
  const fresh = !st.alert || st.alert.kind !== a.kind || Date.now() - st.alert.notifiedAt > 10 * 60 * 1000;
  await setState({ ...st, alert: { ...a, at: Date.now(), notifiedAt: fresh ? Date.now() : st.alert.notifiedAt } });
  if (fresh) {
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
  const st = await getState();
  if (st.alert) await setState({ ...st, alert: null });
}

// A small controller window outside the Meet page, so the mic switch never covers the meeting.
async function openMini() {
  const { miniWindowId } = await chrome.storage.session.get('miniWindowId');
  if (miniWindowId != null) {
    try {
      await chrome.windows.get(miniWindowId);
      return { ok: true };
    } catch {}
  }
  const { miniBounds } = await chrome.storage.local.get('miniBounds');
  const cur = await chrome.windows.getLastFocused().catch(() => null);
  const b = miniBounds || { width: 340, height: 330, left: cur ? Math.max(0, (cur.left || 0) + (cur.width || 800) - 360) : 80, top: cur ? (cur.top || 0) + 80 : 80 };
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('mini.html'), type: 'popup', focused: false, width: b.width, height: b.height, left: b.left, top: b.top });
  await chrome.storage.session.set({ miniWindowId: win.id });
  return { ok: true };
}

async function closeMini() {
  const { miniWindowId } = await chrome.storage.session.get('miniWindowId');
  await chrome.storage.session.remove('miniWindowId');
  if (miniWindowId != null) await chrome.windows.remove(miniWindowId).catch(() => {});
}

chrome.windows.onBoundsChanged?.addListener(async (w) => {
  const { miniWindowId } = await chrome.storage.session.get('miniWindowId');
  if (w.id === miniWindowId && w.width) await chrome.storage.local.set({ miniBounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
});
chrome.windows.onRemoved.addListener(async (id) => {
  const { miniWindowId } = await chrome.storage.session.get('miniWindowId');
  if (id === miniWindowId) await chrome.storage.session.remove('miniWindowId');
});

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
  if (ctxs.length) await chrome.offscreen.closeDocument();
}

const cleanTitle = (t = '') => t.replace(/^Meet\s*[-–]\s*/i, '').replace(/\s*[-–]\s*Google Meet$/i, '').trim() || 'Meeting';

async function start(msg) {
  const st = await getState();
  if (st.recording) return { ok: false, error: 'Already recording another tab.' };
  const settings = await getSettings();
  const id = `m${Date.now()}`;
  await saveMeeting({
    id,
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
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: msg.streamId, settings, meetingId: id });
  if (!r?.ok) {
    await closeOffscreen();
    await updateMeeting(id, (m) => {
      m.endedAt = Date.now();
      m.errors.push(`Start failed: ${r?.error}`);
    });
    return { ok: false, error: r?.error || 'Recorder did not start.' };
  }
  await setState({ recording: true, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null });
  if (settings.miniWindow !== false) openMini().catch(() => {});
  // The pill is a content script; inject it now so it appears without reloading the Meet tab.
  chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['dist/pill.js'] }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: 'REC' });
  // A tab-specific badge (the Meet reminder) would hide the global one on that tab.
  chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: '#d93025' });
  chrome.action.setBadgeText({ tabId: msg.tabId, text: 'REC' });
  return { ok: true };
}

let stopping = null;
function stop() {
  // Popup click, tab close, and track-ended can all fire; only stop once.
  stopping ||= (async () => {
    const st = await getState();
    if (!st.recording) return { ok: true };
    await setState({ ...st, stopping: true });
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    } catch {}
    await updateMeeting(st.meetingId, (m) => (m.endedAt = Date.now()));
    await closeOffscreen();
    await closeMini();
    await setState({ recording: false });
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeText({ tabId: st.tabId, text: '' }).catch(() => {});
    await chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${st.meetingId}`) });
    return { ok: true };
  })().finally(() => (stopping = null));
  return stopping;
}

// Effective mic = what the user wants, unless "follow Meet mute" is on and Meet itself is muted.
async function applyMic(patch = {}) {
  const st = { ...(await getState()), ...patch };
  if (!st.recording || st.stopping) return { ok: false };
  const { followMeetMute } = await getSettings();
  const eff = !!st.micWanted && !!st.mic && !(followMeetMute && st.meetMuted === true);
  let micOn = st.micOn;
  if (eff !== !!st.micOn) {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'mic', on: eff });
    micOn = r?.micOn ?? false;
  }
  await setState({ ...st, micOn });
  return { ok: true, micOn, micWanted: !!st.micWanted };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'bg') return;
  const handlers = {
    start: () => start(msg),
    stop: () => stop(),
    mic: () => applyMic({ micWanted: !!msg.on }),
    'mic-refresh': () => applyMic(),
    'meet-mute': () => applyMic({ meetMuted: msg.muted }),
    whoami: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
    level: () => chrome.storage.session.set({ levels: { tab: msg.tab, mic: msg.mic, ctx: msg.ctx, at: Date.now() } }),
    dbg: () => updateMeeting(msg.meetingId, (m) => (m.debug ||= []).push(msg.note)),
    segment: async () => {
      await updateMeeting(msg.meetingId, (m) => m.segments.push(msg.seg));
      await clearAlert();
    },
    'stt-error': async () => {
      await updateMeeting(msg.meetingId, (m) => m.errors.push(msg.error));
      await raiseAlert(msg.meetingId, msg.error);
    },
    'dismiss-alert': () => clearAlert(),
    'open-mini': () => openMini(),
    'set-follow': async () => {
      await saveSettings({ ...(await getSettings()), followMeetMute: !!msg.on });
      return applyMic();
    },
    'pill-state': async () => {
      const rec = await getState();
      const { levels } = await chrome.storage.session.get('levels');
      const m = rec.meetingId ? await getMeeting(rec.meetingId) : null;
      return { ok: true, rec, levels: levels || null, counts: { segs: m?.segments.length || 0, errs: m?.errors.length || 0 }, follow: (await getSettings()).followMeetMute !== false, showPill: (await getSettings()).pillOnPage === true };
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
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d93025' });
    chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
    chrome.action.setTitle({ tabId: tab.id, title: `Debrief could not start: ${e.message}` });
  }
});

// Reminder: an amber dot on the icon while a Meet call tab is open and not being recorded.
const MEET_CALL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#]|$)/;
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const st = await getState();
  if (st.recording && st.tabId === tabId) return;
  if (MEET_CALL.test(tab.url || '')) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#F59E0B' });
    chrome.action.setBadgeText({ tabId, text: '●' });
    chrome.action.setTitle({ tabId, title: 'Debrief: click (or press Alt+Shift+M) to record this meeting' });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (st.recording && st.tabId === tabId) stop();
});
