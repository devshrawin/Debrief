(() => {
  // src/usage.js
  var FIELDS = ["req", "fail", "rl", "tin", "tout", "audioSec"];
  function dayKey(date = /* @__PURE__ */ new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
  }
  function summarize(usage, days = 1, now = /* @__PURE__ */ new Date()) {
    const out = {};
    for (let i = 0; i < days; i++) {
      const rows = (usage || {})[dayKey(new Date(now.getTime() - i * 864e5))] || {};
      for (const [key2, r] of Object.entries(rows)) {
        const [provider, model, kind] = key2.split("|");
        const t = out[key2] ||= { provider, model, kind, req: 0, fail: 0, rl: 0, tin: 0, tout: 0, audioSec: 0 };
        for (const f of FIELDS) t[f] += r[f] || 0;
      }
    }
    return Object.values(out).sort((a, b) => b.req - a.req);
  }
  function parseLimits(text) {
    const out = {};
    for (const line of String(text || "").split(/\n/)) {
      const m = line.match(/^\s*([\w.:-]+)\s*[=:]\s*(\d+)\s*$/);
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  }
  function nearLimit(usage, limits, now = /* @__PURE__ */ new Date()) {
    const today = summarize(usage, 1, now);
    const hits = [];
    for (const r of today) {
      const limit = limits[r.model];
      if (!limit || r.kind === "tokens") continue;
      const used = today.filter((x) => x.model === r.model).reduce((a, x) => a + x.req, 0);
      if (!hits.some((h) => h.model === r.model) && used >= Math.ceil(limit * 0.8)) hits.push({ model: r.model, used, limit });
    }
    return hits;
  }
  function estimateRequests({ minutes = 60, minSec, maxSec, streams = 1 }) {
    const avg = (minSec + maxSec) / 2;
    return Math.ceil(minutes * 60 / avg) * streams;
  }
  function quotaCheck(usage, limits, settings, { minutes = 60, now = /* @__PURE__ */ new Date() } = {}) {
    if (settings.sttProvider !== "gemini") return null;
    const model = settings.sttGeminiModel;
    const limit = limits?.[model];
    if (!model || !limit) return null;
    const used = summarize(usage, 1, now).filter((r) => r.model === model && r.kind === "stt").reduce((a, r) => a + r.req, 0);
    const secs = settings.sttGeminiChunk === "long" ? { minSec: 200, maxSec: 240 } : { minSec: 100, maxSec: 150 };
    const need = estimateRequests({ minutes, ...secs, streams: 1 });
    const left = Math.max(0, limit - used);
    return { model, limit, used, left, need, minutes, short: need > left, longHelps: settings.sttGeminiChunk !== "long" && estimateRequests({ minutes, minSec: 200, maxSec: 240 }) <= left };
  }

  // src/meetend.js
  var MEET_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;

  // src/iconText.js
  var isIconText = (s) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(s || "").trim());
  var MENU = /^(?:(?:un)?pin|spotlight|remove|mute|unmute|reframe|zoom (?:in|out)|minimi[sz]e|maximi[sz]e|full screen|more actions|add (?:a )?(?:person|people)|keep|send a message)\b.*$/i;
  var UI_PHRASE = /(?:\bcan['\u2019]?t\b|\bcannot\b|\bremotely\b|\bsomeone else\b|\bthis participant\b|^you (?:are|have|will|can)\b|^turn (?:on|off)\b|^(?:backgrounds?|effects?|captions?|activities|host controls|meeting details|participants|people|in the call|contributors|visual effects|apply visual effects|more options|raise hand|lower hand|present now|share screen|leave call|end call|chat|reactions?)(?:\s+(?:and|&)\s+\w+)?$)/i;
  var isMenuText = (s) => {
    const t = String(s || "").trim();
    if (UI_PHRASE.test(t) || t.split(/\s+/).length > 6) return true;
    return /\b(?:to|from) your main screen\b/i.test(t) || /^(?:reframe|zoom in|zoom out|keep|pin|unpin)$/i.test(t) || /^(?:un)?pin\s/i.test(t) || MENU.test(t) && /\b(?:screen|presentation|participant|tile|view)\b/i.test(t);
  };
  var personOfTile = (s) => String(s || "").replace(/[’']s presentation\s*$/i, "").replace(/^more options for\s+/i, "").trim();

  // src/adapters/index.js
  var OTHER_SITES = [
    { name: "Zoom (web client)", matches: ["https://app.zoom.us/*", "https://*.zoom.us/wc/*", "https://zoom.us/wc/*"] },
    { name: "Microsoft Teams", matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*", "https://teams.cloud.microsoft/*"] },
    { name: "Webex", matches: ["https://*.webex.com/*"] },
    { name: "Whereby", matches: ["https://whereby.com/*"] },
    { name: "Jitsi Meet", matches: ["https://meet.jit.si/*", "https://8x8.vc/*"] },
    { name: "GoTo Meeting", matches: ["https://app.goto.com/*", "https://app.gotomeeting.com/*"] },
    { name: "BlueJeans", matches: ["https://app.bluejeans.com/*"] },
    { name: "Amazon Chime", matches: ["https://app.chime.aws/*"] },
    { name: "Zoho Meeting", matches: ["https://meeting.zoho.com/*", "https://meeting.zoho.in/*", "https://meeting.zoho.eu/*"] },
    { name: "Skype for Web", matches: ["https://web.skype.com/*"] }
  ];
  var hostOf = (pattern) => pattern.replace(/^https:\/\//, "").split("/")[0];
  var hostMatches = (pattern, hostname) => {
    const h = hostOf(pattern);
    return h.startsWith("*.") ? hostname === h.slice(2) || hostname.endsWith(h.slice(1)) : hostname === h;
  };
  function platformHint(hostname) {
    const site = siteFor(hostname);
    return site ? `${site.name}: Debrief records the audio. Speaker names and who joined come from Google Meet only; following your mute button and noticing the end of the call are best effort here.` : "";
  }
  function siteFor(hostname) {
    return OTHER_SITES.find((s) => s.matches.some((m) => hostMatches(m, hostname))) || null;
  }
  var isMeetingSite = (hostname) => hostname === "meet.google.com" || !!siteFor(hostname);

  // src/room.js
  function meetingFor(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname === "meet.google.com") return MEET_CODE.test(u.pathname) ? { app: "Google Meet" } : null;
    if (isMeetingSite(u.hostname)) return { app: siteFor(u.hostname)?.name || u.hostname };
    return null;
  }
  var isMeetingUrl = (url) => !!meetingFor(url);
  var roomFor = (url, choice) => typeof choice === "boolean" ? choice : !isMeetingUrl(url);
  function modeHint(url, room, chosen) {
    const m = meetingFor(url);
    if (chosen) return room ? "In a room: your microphone is the meeting, so every voice on it is told apart." : "Online meeting: the call is recorded from this tab and your voice from your microphone.";
    return m ? `${m.app} detected: recording the call from this tab and your voice from your microphone.` : "This is not a meeting link, so Debrief records the room through your microphone.";
  }

  // src/voice/samples.js
  var DB = "debrief-voice";
  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("pieces");
        r.result.createObjectStore("samples");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function tx(store, mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out && typeof out === "object" && "result" in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
  async function deletePieces(meetingId) {
    await tx("pieces", "readwrite", (s) => s.delete(IDBKeyRange.bound(`${meetingId}|`, `${meetingId}|\uFFFF`)));
  }
  async function deleteUnnamedClips(meetingId) {
    await tx("samples", "readwrite", (s) => {
      const r = s.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        if (String(c.key).startsWith(`u:${meetingId}:`)) c.delete();
        c.continue();
      };
    });
  }

  // src/sttclean.js
  var NOT_A_NAME = /^(?:open in new window|backgrounds? and effects|captions?|present now|chat with everyone|raise hand|leave call|turn (?:on|off) .*|more options.*|you can.*|pin|unpin|mute|unmute)$/i;
  function cleanTerms(list) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const raw of list || []) {
      const t = personOfTile(String(raw || "").trim());
      if (!t || t.length < 2 || t.length > 60) continue;
      if (isIconText(t) || isMenuText(t) || NOT_A_NAME.test(t)) continue;
      if (t.split(/\s+/).length > 5) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  // src/audiostore.js
  var DB2 = "debrief";
  var STORE = "pending";
  function open2() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB2, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true }).createIndex("meetingId", "meetingId");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function run(mode, fn) {
    const db = await open2();
    try {
      return await new Promise((resolve, reject) => {
        const tx2 = db.transaction(STORE, mode);
        const req = fn(tx2.objectStore(STORE));
        tx2.oncomplete = () => resolve(req?.result);
        tx2.onerror = () => reject(tx2.error);
      });
    } finally {
      db.close();
    }
  }
  var listPending = (meetingId) => run("readonly", (s) => s.index("meetingId").getAll(meetingId));
  var deletePending = (id) => run("readwrite", (s) => s.delete(id));
  async function deleteAllPending(meetingId) {
    for (const p of await listPending(meetingId)) await deletePending(p.id);
  }

  // src/store.js
  var DEFAULTS = {
    noticeAck: false,
    // the person has confirmed once that they will tell others on the call they are recording
    myName: "",
    captureMic: true,
    meetingLanguages: [],
    // languages to expect (codes from languages.js); empty = automatic
    meetingLanguage: "auto",
    // older single setting (auto | hinglish | malayalam), still honoured when the list is empty
    pillOnPage: false,
    // also show the pill inside the Meet page
    emailSecret: "",
    // made up by Debrief, never typed; the relay script locks itself to it on first use
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
    usdInr: 88,
    // rupees per US dollar, to show the 'cost if paid' estimate in rupees
    usagePrices: "",
    // one "model=USD per 1M input,USD per 1M output" per line
    dictAutoAlias: false,
    // accept clear-cut learned fixes (3+ sightings) without asking
    dictionary: "",
    // names and terms, one per line: Right | misheard, as, this
    minutesMode: "thorough",
    // thorough = extract, write, then check; quick = one pass
    sttGeminiChunk: "standard",
    // standard = 100-150 s chunks; long = about 240 s (fewer requests per meeting)
    minutesFormat: "standard",
    // amnex = the organisation template (header block, attendee tables; Print/PDF, Word, email); standard = Debrief's own layout
    orgName: "",
    // organisation template: name, confidentiality line (page footer) and accent colour; empty = generic. Settings has a "Use Amnex preset" button
    orgConfidential: "",
    orgAccent: "",
    myOrgDomains: "",
    // email domains of the System Integrator side (comma separated); empty = the domain of "Send to", else one list
    peopleDirectory: "",
    // one per line: Name | Honorific | Department | Designation | Organisation [| Chair]
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
    otherSites: true,
    // use the page features (amber dot, mute follow, auto-stop) on Zoom, Teams, Webex and other meeting apps
    voiceOn: false,
    // recognise who is speaking, using voices enrolled in Settings
    voiceSamples: true,
    // keep a short audio clip of each unnamed voice so it can be played to name it (off: no audio is kept)
    voiceLearn: false,
    // learn voices on its own from Meet's captions (needs captions read) and fingerprints of the meeting
    followMeetMute: true,
    // ignore my mic while Meet's own mic button is muted
    momLanguage: "English",
    geminiKey: "",
    // shared by Gemini transcription and the Gemini MOM writer
    geminiKey2: "",
    // optional backup key from a different Google Cloud project
    geminiBackups: [],
    // any number of further backup keys, tried in order after geminiKey2
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
  var AMNEX_PRESET = { orgName: "Amnex Infotechnologies", orgConfidential: "Amnex Infotechnologies Pvt Ltd | Confidential", orgAccent: "#0c2461", myOrgDomains: "amnex.com" };
  function migrateSettings(settings) {
    const next = { ...settings, minutesFormat: settings.minutesFormat ?? "amnex" };
    for (const [k, v] of Object.entries(AMNEX_PRESET)) if (!next[k]) next[k] = v;
    return next;
  }
  var migrating = null;
  function ensureMigrated() {
    migrating ||= (async () => {
      const { settings, schema } = await chrome.storage.local.get(["settings", "schema"]);
      if (schema >= 2) return;
      const legacy = !!settings && Object.keys(settings).length > 0;
      await chrome.storage.local.set({ schema: 2, ...legacy ? { settings: migrateSettings(settings) } : {} });
    })().catch(() => {
      migrating = null;
    });
    return migrating;
  }
  async function getSettings() {
    await ensureMigrated();
    const { settings, learned, voices } = await chrome.storage.local.get(["settings", "learned", "voices"]);
    const learnedNames = cleanTerms(Object.entries(learned?.names || {}).sort((a, b) => a[1] - b[1]).map(([n]) => n)).slice(-80);
    return { ...DEFAULTS, ...settings || {}, learnedNames, voices: voices || [] };
  }
  function sttReady(s) {
    if (s.sttProvider === "gemini") return !!s.geminiKey && !!s.sttGeminiModel;
    if (s.sttProvider === "sarvam") return !!s.sarvamKey;
    if (s.sttProvider === "deepgram") return !!s.deepgramKey;
    return !!s.sttBase && !!s.sttModel;
  }
  function llmReady(s) {
    if (s.llmProvider === "anthropic") return !!s.anthropicKey && !!s.anthropicModel;
    if (s.llmProvider === "gemini") return !!s.geminiKey && !!s.geminiModel;
    return !!s.oaBase && !!s.oaModel;
  }
  var key = (id) => `meeting:${id}`;
  async function getMeeting(id) {
    const r = await chrome.storage.local.get(key(id));
    return r[key(id)] || null;
  }
  async function listMeetings() {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    const r = await chrome.storage.local.get(meetingIds.map(key));
    return meetingIds.map((id) => r[key(id)]).filter(Boolean).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  async function deleteMeeting(id) {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    await chrome.storage.local.set({ meetingIds: meetingIds.filter((x) => x !== id) });
    await chrome.storage.local.remove(key(id));
    await Promise.allSettled([deletePieces(id), deleteAllPending(id), deleteUnnamedClips(id)]);
  }
  async function getState() {
    const { rec } = await chrome.storage.session.get("rec");
    return rec || { recording: false };
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor(sec % 3600 / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  async function setSetting(patch) {
    const { settings } = await chrome.storage.local.get("settings");
    const { learnedNames, voices, ...clean } = patch;
    await chrome.storage.local.set({ settings: { ...settings || {}, ...clean } });
  }
  var nameQueue = Promise.resolve();

  // src/popup.js
  var $ = (id) => document.getElementById(id);
  var framed = window.top !== window;
  var side = new URLSearchParams(location.search).has("side");
  if (side) document.documentElement.classList.add("in-side");
  var tell = (m) => {
    if (framed) window.parent.postMessage({ debriefPanel: true, ...m }, "*");
  };
  var closePanel = () => side ? 0 : framed ? tell({ type: "close" }) : window.close();
  if (framed) {
    tell({ type: "ready" });
    const size = () => tell({ type: "size", h: Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)) });
    new ResizeObserver(size).observe(document.body);
    for (const ms of [150, 600, 1500]) setTimeout(size, ms);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") tell({ type: "close" });
    });
  }
  var send = (msg) => chrome.runtime.sendMessage({ target: "bg", ...msg });
  var show = (id, on) => $(id).classList.toggle("hidden", !on);
  var levelWord = (v) => v == null ? "Off" : v < 3e-3 ? "Silent" : v < 0.012 ? "Quiet" : "Good";
  function setMeter(barId, textId, v) {
    const bar = $(barId);
    bar.style.width = v == null ? "0%" : `${Math.min(100, Math.round(Math.sqrt(v) * 160))}%`;
    bar.className = v != null && v < 3e-3 ? "s" : v != null && v < 0.012 ? "q" : "";
    $(textId).textContent = levelWord(v);
  }
  var pieces = (n) => `${n} transcript piece${n === 1 ? "" : "s"}`;
  function whenOf(m) {
    const d = new Date(m.startedAt);
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(/* @__PURE__ */ new Date()) - day0(d)) / 864e5);
    const day = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    if (!m.endedAt) return day;
    const min = Math.max(1, Math.round((m.endedAt - m.startedAt) / 6e4));
    return `${day} \xB7 ${min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`}`;
  }
  var openMinutes = (id) => chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${id}`) });
  async function refresh() {
    const st = await getState();
    const recording = st.recording && !st.stopping;
    show("idleView", !st.recording);
    show("recView", !!recording);
    show("finView", !!st.stopping);
    $("statusText").textContent = st.stopping ? "Finishing transcription\u2026" : st.recording ? st.paused ? "Paused" : st.room ? "Recording the room" : "Recording" : "Idle";
    show("pause", !!recording);
    show("fullscreen", !!recording);
    $("pause").textContent = st.paused ? "Resume recording" : "Pause recording";
    $("pause").setAttribute("aria-pressed", String(!!st.paused));
    $("timer").textContent = st.recording ? fmtTime((Date.now() - st.startedAt) / 1e3) : "";
    show("start", !st.recording);
    show("modeBox", !st.recording && !blockedTab);
    show("shortcutHint", !st.recording && !blockedTab);
    show("stop", !!recording);
    show("live", !!recording);
    show("micRow", !!(recording && st.mic));
    const wanted = !!(st.micWanted ?? st.micOn);
    $("micToggle").setAttribute("aria-checked", String(wanted));
    $("micStateT").textContent = wanted && !st.micOn ? "Paused: you are muted in the call" : wanted ? st.meetMuted === false ? "Your voice goes into the transcript (unmuted in the call)" : st.meetMuted == null ? "Your voice goes into the transcript (the mute button in the call was not found, so your mic is always on)" : "Your voice goes into the transcript" : "Your voice is ignored";
    $("micState").className = `hint ${!wanted ? "off" : !st.micOn ? "paused" : st.meetMuted == null ? "unknown" : ""}`;
    show("micWarn", !!(recording && st.micError));
    $("micWarn").textContent = st.micError ? `Only other participants are being recorded. ${st.micError}` : "";
    const a = recording ? st.alert : null;
    show("alert", !!a);
    if (a) {
      $("alertTitle").textContent = a.title;
      $("alertText").textContent = a.detail;
      show("alertActionRow", a.kind === "key" || a.kind === "quota");
    }
    const { levels } = await chrome.storage.session.get("levels");
    const fresh = st.recording && levels && Date.now() - levels.at < 4e3;
    if (st.recording) {
      if (fresh) {
        setMeter("lvTab", "lvTabT", levels.tab);
        setMeter("lvMic", "lvMicT", st.micOn ? levels.mic : null);
      } else {
        setMeter("lvTab", "lvTabT", null);
        setMeter("lvMic", "lvMicT", null);
        $("lvTabT").textContent = "No sound data: stop and restart";
      }
      const m = await getMeeting(st.meetingId);
      const n = m?.segments.length || 0;
      const errs = m?.errors.length || 0;
      const info = $("segInfo");
      const spans = [pieces(n), `${errs} error${errs === 1 ? "" : "s"}`];
      if (!n) spans.push("First one lands after about 2 to 3 min.");
      info.replaceChildren(...spans.map((t) => Object.assign(document.createElement("span"), { textContent: t })));
      info.title = errs ? "Failed chunks are kept and can be retried from the minutes page." : "";
      if (st.stopping) $("finInfo").textContent = `${pieces(n)} so far. Then the minutes are written, about 30 s. You can close this popup.`;
      $("finOpen").onclick = (e) => {
        e.preventDefault();
        openMinutes(st.meetingId);
      };
    }
  }
  async function usageWarning() {
    const { usage, learnedLimits = {} } = await chrome.storage.local.get(["usage", "learnedLimits"]);
    const settings = await getSettings();
    const hits = nearLimit(usage, { ...learnedLimits, ...parseLimits(settings.usageLimits) });
    const today = (/* @__PURE__ */ new Date()).toDateString();
    const closedToday = (await chrome.storage.local.get("usageWarnHiddenDay")).usageWarnHiddenDay === today;
    show("usageWarn", !!hits.length && !closedToday);
    $("usageWarnText").textContent = hits.map((h) => `${h.model}: ${h.used} of ${h.limit} requests used today`).join(" \xB7 ") + ". Debrief will fall back to other models if one runs out.";
    const q = quotaCheck(usage, { ...learnedLimits, ...parseLimits(settings.usageLimits) }, settings);
    const hidden = (await chrome.storage.local.get("quotaWarnHidden")).quotaWarnHidden === true;
    show("quotaWarn", !!q?.short && !hidden);
    if (q?.short) $("quotaWarnText").textContent = `A one-hour meeting needs about ${q.need} requests and ${q.left} are left today (${q.used} of ${q.limit} used). ${q.longHelps ? 'Choose "About 4 minutes (fewer requests)" in Settings \u2192 Speech to text to make it fit.' : "Part of the meeting may be kept as audio to transcribe tomorrow."}`;
  }
  $("usageWarnX").onclick = async () => {
    await chrome.storage.local.set({ usageWarnHiddenDay: (/* @__PURE__ */ new Date()).toDateString() });
    show("usageWarn", false);
  };
  $("quotaWarnX").onclick = async () => {
    await chrome.storage.local.set({ quotaWarnHidden: true });
    show("quotaWarn", false);
  };
  var armed = null;
  var allMeetings = [];
  var TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>';
  function emptyState(title, hint) {
    const d = document.createElement("div");
    d.className = "empty";
    const t = document.createElement("strong");
    t.textContent = title;
    const h = document.createElement("p");
    h.className = "hint";
    h.style.margin = "0";
    h.textContent = hint;
    d.append(t, h);
    return d;
  }
  async function renderRecent() {
    allMeetings = await listMeetings();
    show("clearAll", !!allMeetings.length);
    $("meetCount").textContent = allMeetings.length;
    const last = allMeetings[0];
    show("lastBox", !!last);
    if (last) {
      $("lastTitle").textContent = last.title;
      $("lastTitle").title = last.title;
      $("lastWhen").textContent = whenOf(last);
      show("lastMail", !!last.emailedAt);
      $("lastOpen").onclick = (e) => {
        e.preventDefault();
        openMinutes(last.id);
      };
    }
    await drawList();
  }
  async function drawList() {
    const q = $("q").value.trim().toLowerCase();
    const items = allMeetings.filter((m) => !q || `${m.title} ${(m.attendees || []).join(" ")}`.toLowerCase().includes(q));
    if (!allMeetings.length) {
      $("recent").replaceChildren(emptyState("No meetings yet", "Recorded meetings and their minutes appear here."));
      return;
    }
    if (!items.length) {
      $("recent").replaceChildren(emptyState("No match", "No meeting has that in its title or people."));
      return;
    }
    const st = await getState();
    $("recent").replaceChildren(
      ...items.map((m) => {
        const row = document.createElement("div");
        row.className = `item${armed === m.id ? " armed" : ""}`;
        const a = document.createElement("a");
        a.className = "open";
        a.href = "#";
        const t = document.createElement("div");
        t.className = "t trunc";
        t.textContent = m.title;
        t.title = m.title;
        const meta = document.createElement("div");
        meta.className = "m";
        meta.append(Object.assign(document.createElement("span"), { textContent: whenOf(m) }));
        if (m.emailedAt) meta.append(Object.assign(document.createElement("span"), { className: "chip brand", textContent: "Emailed" }));
        a.append(t, meta);
        a.onclick = (e) => {
          e.preventDefault();
          openMinutes(m.id);
        };
        row.append(a);
        const live = st.recording && st.meetingId === m.id;
        if (!live) {
          const del = document.createElement("button");
          if (armed === m.id) {
            del.className = "confirm";
            del.textContent = "Delete?";
            del.setAttribute("aria-label", `Confirm: delete ${m.title}`);
          } else {
            del.className = "del";
            del.innerHTML = TRASH;
            del.title = "Delete this meeting";
            del.setAttribute("aria-label", `Delete ${m.title}`);
          }
          del.onclick = async () => {
            if (armed !== m.id) {
              armed = m.id;
              await drawList();
              $("recent").querySelector(".confirm")?.focus();
              setTimeout(() => {
                if (armed === m.id) {
                  armed = null;
                  drawList();
                }
              }, 3e3);
              return;
            }
            armed = null;
            await deleteMeeting(m.id);
            await renderRecent();
            $("q").focus();
          };
          row.append(del);
        }
        return row;
      })
    );
  }
  $("q").oninput = drawList;
  function selectTab(b) {
    document.querySelectorAll("#tabs [role=tab]").forEach((x) => {
      x.setAttribute("aria-selected", String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    });
    document.querySelectorAll("[role=tabpanel]").forEach((p) => p.hidden = p.id !== b.dataset.pane);
  }
  document.querySelectorAll("#tabs [role=tab]").forEach((b) => {
    b.onclick = () => selectTab(b);
    b.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const tabs = [...document.querySelectorAll("#tabs [role=tab]")];
      const i = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (tabs.indexOf(b) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[i]);
      tabs[i].focus();
    };
  });
  $("clearAll").onclick = async () => {
    const b = $("clearAll");
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.classList.add("armed");
      b.textContent = "Click again to delete all";
      setTimeout(() => {
        b.dataset.armed = "";
        b.classList.remove("armed");
        b.textContent = "Clear all";
      }, 3e3);
      return;
    }
    const st = await getState();
    for (const m of await listMeetings()) if (!(st.recording && st.meetingId === m.id)) await deleteMeeting(m.id);
    b.dataset.armed = "";
    b.classList.remove("armed");
    b.textContent = "Clear all";
    renderRecent();
  };
  async function readPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const r = await chrome.tabs.sendMessage(tab.id, { target: "page", type: "diagnose" });
      return r?.ok ? r : null;
    } catch {
      return null;
    }
  }
  function renderDiag(r) {
    const box = $("diagResult");
    box.replaceChildren();
    const span = (cls, text) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
    if (!r) {
      box.append(span("full", "Open a Meet (or enabled meeting site) tab and reload it once, then try again."));
      return;
    }
    const d = r.diag || {};
    const row = (label, text, ok) => box.append(span("", label), span(`chip ${ok ? "ok" : "warn"}`, text));
    const mic = String(d.micButton || "");
    const micFound = /^found/i.test(mic);
    row("Mute button", micFound ? `Found \xB7 ${/unmuted/i.test(mic) ? "unmuted" : "muted"}` : "Not found", micFound);
    const ppl = String(d.participants || "");
    const n = ppl.match(/^(\d+) found/);
    if (!/not read/i.test(ppl)) row("People list", n ? `${n[1]} name${n[1] === "1" ? "" : "s"}` : "None found \xB7 open People", !!n);
    const capOn = /^region found/i.test(String(d.captions || ""));
    if (!/not read/i.test(String(d.captions || ""))) row("Captions", capOn ? "On" : "Off \xB7 turn on for names", capOn);
    box.append(span("hint full", `${r.site || "This page"} \xB7 ${String(d.inCall || "")}`));
  }
  $("diagnose").onclick = async (e) => {
    e.preventDefault();
    const open3 = $("diagnose").getAttribute("aria-expanded") !== "true";
    $("diagnose").setAttribute("aria-expanded", String(open3));
    show("diagResult", open3);
    if (!open3) return;
    $("diagResult").textContent = "Checking\u2026";
    renderDiag(await readPage());
  };
  async function detectCall() {
    const r = await readPage();
    const inCall = /^yes/i.test(String(r?.diag?.inCall || ""));
    show("callBanner", inCall);
    if (inCall) $("callSite").textContent = `${r.site || "Meeting"} \xB7 this tab`;
  }
  $("askAll").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("ask.html") });
  };
  $("askHome").onclick = $("askAll").onclick;
  $("alertX").onclick = () => send({ type: "dismiss-alert" }).then(refresh);
  $("alertAction").onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  var tabUrl = "";
  var blockedTab = false;
  var chosenRoom = null;
  var currentRoom = () => roomFor(tabUrl, chosenRoom);
  function paintMode() {
    const room = currentRoom();
    $("modeOnline").setAttribute("aria-checked", String(!room));
    $("modeRoom").setAttribute("aria-checked", String(room));
    $("modeHint").textContent = modeHint(tabUrl, room, chosenRoom !== null && chosenRoom !== !isMeetingUrl(tabUrl));
    if ($("start").dataset.notice !== "1") $("startLabel").textContent = room ? "Start recording the room" : "Start recording this tab";
  }
  for (const [id, value] of [["modeOnline", false], ["modeRoom", true]]) {
    $(id).onclick = () => {
      chosenRoom = value;
      paintMode();
    };
  }
  var noticeAck = null;
  $("start").onclick = async () => {
    if (noticeAck === null) noticeAck = !!(await getSettings()).noticeAck;
    if (!noticeAck) {
      const label = $("startLabel");
      if ($("start").dataset.notice !== "1") {
        $("start").dataset.notice = "1";
        label.textContent = "I will tell everyone I am recording. Start";
        $("shortcutHint").textContent = "Recording people without telling them can be illegal where you work or live. Debrief records only the tab you pick, and keeps it on your computer and with the services you chose.";
        return;
      }
      noticeAck = true;
      setSetting({ noticeAck: true }).catch(() => {
      });
    }
    $("start").disabled = true;
    try {
      show("error", false);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await send({ type: "start", streamId, tabId: tab.id, title: tab.title, url: tab.url, room: currentRoom() });
      if (!r?.ok) throw new Error(r?.error || "unknown error");
    } catch (e) {
      $("error").textContent = `Could not start: ${e.message}`;
      show("error", true);
    } finally {
      $("start").disabled = false;
      refresh();
    }
  };
  $("fullscreen").onclick = async () => {
    await send({ type: "window-fullscreen" });
    closePanel();
  };
  $("pause").onclick = async () => {
    $("pause").disabled = true;
    await send({ type: "pause" });
    $("pause").disabled = false;
    refresh();
  };
  var discardTimer = null;
  $("discard").onclick = async () => {
    const b = $("discard");
    if (b.dataset.sure !== "1") {
      b.dataset.sure = "1";
      b.textContent = "Tap again to delete it. No transcript, no minutes.";
      clearTimeout(discardTimer);
      discardTimer = setTimeout(() => {
        b.dataset.sure = "";
        b.textContent = "Started by mistake? Discard this recording";
      }, 5e3);
      return;
    }
    clearTimeout(discardTimer);
    b.disabled = true;
    await send({ type: "discard" });
    closePanel();
  };
  $("stop").onclick = async () => {
    $("stop").disabled = true;
    await send({ type: "stop" });
    closePanel();
  };
  $("micToggle").onclick = () => {
    const on = $("micToggle").getAttribute("aria-checked") !== "true";
    $("micToggle").setAttribute("aria-checked", String(on));
    send({ type: "mic", on }).then(refresh);
  };
  for (const id of ["openTour", "openTour1"]) {
    $(id).onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?restart=1") });
    };
  }
  for (const id of ["openSettings", "openSettings1"]) {
    $(id).onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    };
  }
  (async () => {
    const s = await getSettings();
    const ready = sttReady(s) && llmReady(s);
    show("setup", !ready);
    const needGemini = (s.sttProvider === "gemini" || s.llmProvider === "gemini") && !s.geminiKey;
    $("setupMsg").textContent = needGemini ? "Add your free Gemini key first." : !sttReady(s) ? "Add your speech-to-text key in Settings." : "Add your minutes writer key in Settings.";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const blocked = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(tab?.url || "");
    show("cantRecord", blocked);
    blockedTab = blocked;
    $("start").disabled = !sttReady(s) || blocked;
    let host = "";
    try {
      host = new URL(tab?.url || "").hostname;
    } catch {
    }
    tabUrl = tab?.url || "";
    paintMode();
    $("platformHint").textContent = platformHint(host);
    show("platformHint", !!platformHint(host));
    const syncOnline = () => show("offline", !navigator.onLine);
    syncOnline();
    addEventListener("online", syncOnline);
    addEventListener("offline", syncOnline);
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "toggle-recording");
    $("shortcutHint").innerHTML = cmd?.shortcut ? `Tell people you are recording. <kbd>${cmd.shortcut.split("+").join("</kbd>+<kbd>")}</kbd> also starts and stops, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> mutes your mic.` : "Tell people you are recording. Set a start/stop shortcut at chrome://extensions/shortcuts.";
    await refresh();
    usageWarning();
    await renderRecent();
    if (isMeetingSite(host)) detectCall();
    setInterval(refresh, 1e3);
  })();
})();
