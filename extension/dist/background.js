(() => {
  // src/alerts.js
  function classifyError(err) {
    const e = String(err || "");
    const model = (e.match(/model:\s*([\w.-]+)/i) || [])[1];
    const retry = (e.match(/retry in\s*([\dhms.]+)/i) || [])[1];
    if (/API key not valid|API_KEY_INVALID|\b(401|403)\b/i.test(e)) {
      return {
        kind: "key",
        title: "API key rejected",
        detail: "Google says the key is invalid or lacks access. Check it in Debrief settings. Audio is kept and will retry."
      };
    }
    if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(e)) {
      const reset = retry ? `, resets in about ${retry.replace(/\.\d+s?$/, "")}` : "";
      return {
        kind: "quota",
        title: "API limit reached",
        detail: `${model ? `${model}: ` : ""}free-tier limit used up${reset}. Debrief tries other models first; chunks that still fail are kept and retried from the MOM page.`
      };
    }
    return null;
  }

  // src/meetend.js
  var MEET_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;

  // src/usage.js
  function dayKey(date = /* @__PURE__ */ new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
  }
  var rowKey = (e) => `${e.provider}|${e.model || "-"}|${e.kind}`;
  function addEntry(usage, e, now = /* @__PURE__ */ new Date()) {
    const next = { ...usage || {} };
    const day = dayKey(now);
    const rows = { ...next[day] || {} };
    const key2 = rowKey(e);
    const row = { req: 0, fail: 0, rl: 0, tin: 0, tout: 0, audioSec: 0, ...rows[key2] || {} };
    row.req += e.req || 0;
    row.fail += e.fail ? 1 : 0;
    row.rl += e.rl ? 1 : 0;
    row.tin += e.tin || 0;
    row.tout += e.tout || 0;
    row.audioSec += e.audioSec || 0;
    rows[key2] = row;
    next[day] = rows;
    const keep = new Date(now.getTime() - 62 * 864e5);
    for (const d of Object.keys(next)) if (d < dayKey(keep)) delete next[d];
    return next;
  }

  // src/store.js
  var DEFAULTS = {
    myName: "",
    captureMic: true,
    meetingLanguage: "auto",
    // auto | hinglish | malayalam
    pillOnPage: false,
    // also show the pill inside the Meet page
    emailWebhook: "",
    // Google Apps Script web app URL (apps-script/Code.gs)
    emailTo: "",
    // optional; the script only allows you and its ALLOWED list
    emailAuto: true,
    // email the MOM as soon as it is written
    emailPdf: true,
    // attach the MOM as PDF
    emailWord: false,
    // attach the MOM as Word (.doc)
    emailMd: false,
    // attach the MOM as Markdown
    emailTranscript: false,
    // attach the transcript as .txt
    autoStop: true,
    // stop recording by itself when the meeting is over
    autoStopQuietMin: 10,
    // ...or after this many silent minutes (0 = never)
    usageLimits: "",
    // one "model=daily requests" per line; learned from 429s too
    usagePrices: "",
    // one "model=USD per 1M input,USD per 1M output" per line
    dictAutoAlias: false,
    // accept clear-cut learned fixes (3+ sightings) without asking
    dictionary: "",
    // names and terms, one per line: Right | misheard, as, this
    minutesMode: "thorough",
    // thorough = extract, write, then check; quick = one pass
    shareList: "",
    // default people to share the minutes with
    shareGroups: "",
    // per recurring meeting: "title words | a@x.com, b@y.com"
    shareMode: "review",
    // review = only I get it until I press Share; auto = send to them too
    shareHow: "to",
    // to | cc | bcc
    shareDomains: false,
    // script helper: allow whole company domains instead of single addresses
    calendarLookup: true,
    // ask the relay who was invited (needs the calendar permission)
    meetCaptions: "read",
    // read speaker names from Meet's captions: off | read (when you have captions on) | auto (turn them on)
    otherSites: false,
    // experimental: generic detection on Teams, Zoom web, Webex, Whereby, Jitsi
    followMeetMute: true,
    // ignore my mic while Meet's own mic button is muted
    momLanguage: "English",
    geminiKey: "",
    // shared by Gemini transcription and the Gemini MOM writer
    geminiKey2: "",
    // optional backup key from a different Google Cloud project
    sttProvider: "gemini",
    // gemini | sarvam | deepgram | openai
    sttGeminiModel: "gemini-3.5-transcribe",
    sarvamKey: "",
    sarvamModel: "saaras:v4",
    sarvamMode: "codemix",
    // codemix | transcribe | translate
    sarvamLanguage: "unknown",
    deepgramKey: "",
    deepgramModel: "nova-3",
    sttBase: "https://api.groq.com/openai/v1",
    sttKey: "",
    sttModel: "whisper-large-v3",
    sttPrompt: "Hinglish office meeting. Hindi in Devanagari, English words in English.",
    llmProvider: "gemini",
    // gemini | anthropic | openai
    anthropicKey: "",
    anthropicModel: "claude-opus-5-5",
    oaBase: "https://api.openai.com/v1",
    oaKey: "",
    oaModel: "",
    geminiModel: "gemini-3.8-flash"
  };
  async function getSettings() {
    const { settings, learned } = await chrome.storage.local.get(["settings", "learned"]);
    const learnedNames = Object.entries(learned?.names || {}).sort((a, b) => a[1] - b[1]).map(([n]) => n).slice(-80);
    return { ...DEFAULTS, ...settings || {}, learnedNames };
  }
  async function saveSettings(s) {
    const { learnedNames, ...own } = s;
    await chrome.storage.local.set({ settings: own });
  }
  function sttReady(s) {
    if (s.sttProvider === "gemini") return !!s.geminiKey && !!s.sttGeminiModel;
    if (s.sttProvider === "sarvam") return !!s.sarvamKey;
    if (s.sttProvider === "deepgram") return !!s.deepgramKey;
    return !!s.sttBase && !!s.sttModel;
  }
  var key = (id) => `meeting:${id}`;
  async function getMeeting(id) {
    const r = await chrome.storage.local.get(key(id));
    return r[key(id)] || null;
  }
  async function saveMeeting(m) {
    await chrome.storage.local.set({ [key(m.id)]: m });
  }
  async function addMeetingId(id) {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    await chrome.storage.local.set({ meetingIds: [id, ...meetingIds] });
  }
  async function getState() {
    const { rec } = await chrome.storage.session.get("rec");
    return rec || { recording: false };
  }
  async function setState(rec) {
    await chrome.storage.session.set({ rec });
  }

  // src/background.js
  chrome.runtime.onInstalled.addListener((d) => {
    if (d.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?restart=1") });
  });
  chrome.storage.session.setAccessOptions?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  var chain = Promise.resolve();
  var serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {
    });
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
    const fresh = !st.alert || st.alert.kind !== a.kind || Date.now() - st.alert.notifiedAt > 10 * 60 * 1e3;
    await setState({ ...st, alert: { ...a, at: Date.now(), notifiedAt: fresh ? Date.now() : st.alert.notifiedAt } });
    if (fresh) {
      chrome.notifications?.create(`debrief-${a.kind}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: `Debrief: ${a.title}`,
        message: a.detail,
        priority: 2
      });
    }
  }
  async function clearAlert() {
    const st = await getState();
    if (st.alert) await setState({ ...st, alert: null });
  }
  async function ensureOffscreen() {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctxs.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Record meeting tab audio and microphone for transcription"
    });
  }
  async function closeOffscreen() {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctxs.length) await chrome.offscreen.closeDocument();
  }
  var cleanTitle = (t = "") => t.replace(/^Meet\s*[-–]\s*/i, "").replace(/\s*[-–]\s*Google Meet$/i, "").trim() || "Meeting";
  async function start(msg) {
    const st = await getState();
    if (st.recording) return { ok: false, error: "Already recording another tab." };
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
      mom: "",
      stt: settings.sttProvider
    });
    await addMeetingId(id);
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId: msg.streamId, settings, meetingId: id });
    if (!r?.ok) {
      await closeOffscreen();
      await updateMeeting(id, (m) => {
        m.endedAt = Date.now();
        m.errors.push(`Start failed: ${r?.error}`);
      });
      return { ok: false, error: r?.error || "Recorder did not start." };
    }
    await setState({ recording: true, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null, meetCode: (msg.url || "").match(MEET_CODE)?.[0] || null });
    await chrome.storage.session.set({ quietSince: Date.now() });
    chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["dist/pill.js"] }).catch(() => {
    });
    chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: "#d93025" });
    chrome.action.setBadgeText({ tabId: msg.tabId, text: "REC" });
    return { ok: true };
  }
  var stopping = null;
  function stop(opts = {}) {
    stopping ||= (async () => {
      const st = await getState();
      if (!st.recording) return { ok: true };
      await setState({ ...st, stopping: true });
      try {
        await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
      } catch {
      }
      await updateMeeting(st.meetingId, (m) => m.endedAt = Date.now());
      await closeOffscreen();
      await setState({ recording: false });
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setBadgeText({ tabId: st.tabId, text: "" }).catch(() => {
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${st.meetingId}`), active: !opts.background });
      return { ok: true };
    })().finally(() => stopping = null);
    return stopping;
  }
  async function applyMic(patch = {}) {
    const st = { ...await getState(), ...patch };
    if (!st.recording || st.stopping) return { ok: false };
    const { followMeetMute } = await getSettings();
    const eff = !!st.micWanted && !!st.mic && !(followMeetMute && st.meetMuted === true);
    let micOn = st.micOn;
    if (eff !== !!st.micOn) {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "mic", on: eff });
      micOn = r?.micOn ?? false;
    }
    await setState({ ...st, micOn });
    return { ok: true, micOn, micWanted: !!st.micWanted };
  }
  async function autoStop(reason) {
    const st = await getState();
    if (!st.recording || st.stopping) return;
    await updateMeeting(st.meetingId, (m) => (m.debug ||= []).push(`auto-stop: ${reason}`));
    await stop({ background: true });
    chrome.notifications?.create("debrief-autostop", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Debrief stopped recording",
      message: `${reason} Writing the minutes now.`
    });
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== "bg") return;
    const handlers = {
      start: () => start(msg),
      stop: () => stop(),
      mic: () => applyMic({ micWanted: !!msg.on }),
      "mic-refresh": () => applyMic(),
      "meet-mute": () => applyMic({ meetMuted: msg.muted }),
      whoami: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
      level: async () => {
        await chrome.storage.session.set({ levels: { tab: msg.tab, mic: msg.mic, ctx: msg.ctx, at: Date.now() } });
        const now = Date.now();
        const { quietSince } = await chrome.storage.session.get("quietSince");
        if (Math.max(msg.tab || 0, msg.mic || 0) >= 0.012 || !quietSince) {
          await chrome.storage.session.set({ quietSince: now });
          return;
        }
        const s = await getSettings();
        const mins = Number(s.autoStopQuietMin);
        if (s.autoStop !== false && mins > 0 && now - quietSince > mins * 6e4) await autoStop(`It was silent for ${mins} minutes.`);
      },
      "meet-ended": async () => {
        const st = await getState();
        if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
        if ((await getSettings()).autoStop === false) return { ok: false };
        await autoStop("The meeting ended.");
        return { ok: true };
      },
      dbg: () => updateMeeting(msg.meetingId, (m) => (m.debug ||= []).push(msg.note)),
      segment: async () => {
        await updateMeeting(msg.meetingId, (m) => m.segments.push(msg.seg));
        await clearAlert();
      },
      "stt-error": async () => {
        await updateMeeting(msg.meetingId, (m) => m.errors.push(msg.error));
        await raiseAlert(msg.meetingId, msg.error);
      },
      usage: () => serial(async () => {
        const { usage, learnedLimits = {} } = await chrome.storage.local.get(["usage", "learnedLimits"]);
        const next = { usage: addEntry(usage, msg.entry) };
        if (msg.entry?.learned) next.learnedLimits = { ...learnedLimits, [msg.entry.learned.model]: msg.entry.learned.limit };
        await chrome.storage.local.set(next);
      }),
      // People and captions sampled from the meeting page: who was there when, and who spoke.
      "meet-snap": async () => {
        const st = await getState();
        if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
        const me = (await getSettings()).myName;
        const who = (n) => /^you$/i.test(n) && me ? me : n;
        await updateMeeting(st.meetingId, (m) => {
          const pres = m.presence ||= {};
          for (const n of msg.names || []) {
            const k = who(n);
            const p = pres[k];
            if (p) {
              p[1] = msg.t;
              p[2] = (p[2] || 0) + 1;
            } else pres[k] = [msg.t, msg.t, 1];
          }
          if (msg.names) {
          }
          const caps = m.captions ||= [];
          for (const c of msg.captions || []) {
            const name = who(c.name);
            const last = [...caps].reverse().find((x) => x.name === name);
            if (last && c.t - last.t2 < 15 && (c.text.startsWith(last.text) || last.text.startsWith(c.text) || last.text.slice(0, 20) === c.text.slice(0, 20))) {
              last.text = c.text.length >= last.text.length ? c.text : last.text;
              last.t2 = c.t;
            } else caps.push({ t: c.t, t2: c.t, name, text: c.text });
          }
          if (caps.length > 4e3) caps.splice(0, caps.length - 4e3);
        });
        return { ok: true };
      },
      // Switch the page script on for other meeting sites (Teams, Zoom web, ...) once the user grants access.
      sites: async () => {
        const id = "debrief-sites";
        const have = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
        if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
        if (msg.on) {
          await chrome.scripting.registerContentScripts([{ id, matches: msg.matches, js: ["dist/pill.js"], runAt: "document_idle", persistAcrossSessions: true }]);
        }
        return { ok: true };
      },
      // A page script saw a live call (or the call ended): glow the icon amber unless we are already recording it.
      "in-call": async () => {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false };
        const st = await getState();
        if (st.recording && st.tabId === tabId) return { ok: true };
        if (msg.on) {
          chrome.action.setBadgeBackgroundColor({ tabId, color: "#F59E0B" });
          chrome.action.setBadgeText({ tabId, text: "\u25CF" });
          chrome.action.setTitle({ tabId, title: `Debrief: a ${msg.site || "meeting"} call is on. Click (or press Alt+Shift+M) to record it` });
        } else {
          chrome.action.setBadgeText({ tabId, text: "" });
        }
        return { ok: true };
      },
      "dismiss-alert": () => clearAlert(),
      "set-follow": async () => {
        await saveSettings({ ...await getSettings(), followMeetMute: !!msg.on });
        return applyMic();
      },
      "pill-state": async () => {
        const rec = await getState();
        const { levels } = await chrome.storage.session.get("levels");
        const m = rec.meetingId ? await getMeeting(rec.meetingId) : null;
        return { ok: true, rec, levels: levels || null, counts: { segs: m?.segments.length || 0, errs: m?.errors.length || 0 }, follow: (await getSettings()).followMeetMute !== false, showPill: (await getSettings()).pillOnPage === true, captionMode: (await getSettings()).meetCaptions || "read" };
      }
    };
    const h = handlers[msg.type];
    if (!h) return;
    h().then(
      (r) => sendResponse(r ?? { ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  });
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "toggle-mic") {
      const cur = await getState();
      if (cur.recording) await applyMic({ micWanted: !(cur.micWanted ?? cur.micOn) });
      return;
    }
    if (command !== "toggle-recording") return;
    const st = await getState();
    if (st.recording) return stop();
    if (!tab?.id) return;
    if (!sttReady(await getSettings())) return chrome.runtime.openOptionsPage();
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await start({ streamId, tabId: tab.id, title: tab.title, url: tab.url });
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#d93025" });
      chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
      chrome.action.setTitle({ tabId: tab.id, title: `Debrief could not start: ${e.message}` });
    }
  });
  var MEET_CALL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#]|$)/;
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (!info.url && info.status !== "complete") return;
    const st = await getState();
    if (st.recording && st.tabId === tabId) return;
    if (MEET_CALL.test(tab.url || "")) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#F59E0B" });
      chrome.action.setBadgeText({ tabId, text: "\u25CF" });
      chrome.action.setTitle({ tabId, title: "Debrief: click (or press Alt+Shift+M) to record this meeting" });
    }
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!info.url) return;
    const st = await getState();
    if (!st.recording || st.stopping || tabId !== st.tabId || !st.meetCode) return;
    if (info.url.includes(st.meetCode)) return;
    if ((await getSettings()).autoStop === false) return;
    await autoStop("You left the meeting page.");
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const st = await getState();
    if (st.recording && st.tabId === tabId) stop();
  });
})();
