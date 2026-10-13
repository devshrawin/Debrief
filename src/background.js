import { classifyError } from './alerts.js';
import { MEET_CODE } from './meetend.js';
import { addEntry } from './usage.js';
import { getSettings, saveSettings, sttReady, getMeeting, saveMeeting, addMeetingId, getState, setState } from './store.js';

// Meeting records are read-modify-written from several messages; run those one at a time.
// First install: show the guided tour. (Updates stay quiet; the popup has a Take the tour link.)
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?restart=1') });
});

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
  await setState({ recording: true, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null, meetCode: (msg.url || '').match(MEET_CODE)?.[0] || null });
  await chrome.storage.session.set({ quietSince: Date.now() });
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
function stop(opts = {}) {
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
    await setState({ recording: false });
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeText({ tabId: st.tabId, text: '' }).catch(() => {});
    // After an automatic stop, open the minutes in the background so it doesn't pull you out of what you're doing.
    await chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${st.meetingId}`), active: !opts.background });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'bg') return;
  const handlers = {
    start: () => start(msg),
    stop: () => stop(),
    mic: () => applyMic({ micWanted: !!msg.on }),
    'mic-refresh': () => applyMic(),
    'meet-mute': () => applyMic({ meetMuted: msg.muted }),
    whoami: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
    level: async () => {
      await chrome.storage.session.set({ levels: { tab: msg.tab, mic: msg.mic, ctx: msg.ctx, at: Date.now() } });
      // Safety net: nobody (including you) has made a sound for a long time, so the meeting is over.
      const now = Date.now();
      const { quietSince } = await chrome.storage.session.get('quietSince');
      if (Math.max(msg.tab || 0, msg.mic || 0) >= 0.012 || !quietSince) {
        await chrome.storage.session.set({ quietSince: now });
        return;
      }
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
        for (const n of msg.names || []) {
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
          const last = [...caps].reverse().find((x) => x.name === name);
          if (last && c.t - last.t2 < 15 && (c.text.startsWith(last.text) || last.text.startsWith(c.text) || last.text.slice(0, 20) === c.text.slice(0, 20))) {
            last.text = c.text.length >= last.text.length ? c.text : last.text;
            last.t2 = c.t;
          } else caps.push({ t: c.t, t2: c.t, name, text: c.text });
        }
        if (caps.length > 4000) caps.splice(0, caps.length - 4000);
      });
      return { ok: true };
    },
    // Switch the page script on for other meeting sites (Teams, Zoom web, ...) once the user grants access.
    sites: async () => {
      const id = 'debrief-sites';
      const have = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
      if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
      if (msg.on) {
        await chrome.scripting.registerContentScripts([{ id, matches: msg.matches, js: ['dist/pill.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
      }
      return { ok: true };
    },
    // A page script saw a live call (or the call ended): glow the icon amber unless we are already recording it.
    'in-call': async () => {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false };
      const st = await getState();
      if (st.recording && st.tabId === tabId) return { ok: true };
      if (msg.on) {
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#F59E0B' });
        chrome.action.setBadgeText({ tabId, text: '●' });
        chrome.action.setTitle({ tabId, title: `Debrief: a ${msg.site || 'meeting'} call is on. Click (or press Alt+Shift+M) to record it` });
      } else {
        chrome.action.setBadgeText({ tabId, text: '' });
      }
      return { ok: true };
    },
    'dismiss-alert': () => clearAlert(),
    'set-follow': async () => {
      await saveSettings({ ...(await getSettings()), followMeetMute: !!msg.on });
      return applyMic();
    },
    'pill-state': async () => {
      const rec = await getState();
      const { levels } = await chrome.storage.session.get('levels');
      const m = rec.meetingId ? await getMeeting(rec.meetingId) : null;
      return { ok: true, rec, levels: levels || null, counts: { segs: m?.segments.length || 0, errs: m?.errors.length || 0 }, follow: (await getSettings()).followMeetMute !== false, showPill: (await getSettings()).pillOnPage === true, captionMode: (await getSettings()).meetCaptions || 'read' };
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
  const st = await getState();
  if (st.recording && st.tabId === tabId) stop();
});
