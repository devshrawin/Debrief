(() => {
  // src/iconText.js
  var isIconText = (s) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(s || "").trim());

  // src/voice/match.js
  function cosine(a, b) {
    let s = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      s += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return s / (Math.sqrt(na * nb) || 1);
  }
  function normalize(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return Float32Array.from(v, (x) => x / n);
  }
  function mean(vectors) {
    const out = new Float32Array(vectors[0].length);
    for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
    return normalize(out);
  }
  function pack(emb) {
    const bytes = new Int8Array(emb.length);
    for (let i = 0; i < emb.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(emb[i] * 127)));
    let bin = "";
    for (const b of new Uint8Array(bytes.buffer)) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function unpack(b64) {
    const bin = atob(b64);
    const out = new Float32Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24 >> 24) / 127;
    return normalize(out);
  }

  // src/voice/learn.js
  var LEARN = {
    lead: 2,
    // seconds a caption may lag behind the speech (the speech started this much before it showed)
    tail: 1,
    clear: 1.5,
    // seconds around a piece in which no other speaker's caption may appear
    minPieces: 6,
    // evidence needed from one meeting before it counts
    minSecs: 15,
    readySecs: 45,
    // total clean speech before a learned voice is used
    readyMeetings: 2,
    // and it must have been seen in this many different meetings
    outlier: 0.35,
    // pieces below this similarity to the person's own average are dropped
    twin: 0.8,
    // two names this similar are ambiguous
    keep: 12
    // individual fingerprints kept
  };
  var norm = (n) => String(n || "").toLowerCase().replace(/\s+/g, " ").trim();
  var isMe = (n, myName) => /^you$/i.test(String(n).trim()) || myName && norm(n) === norm(myName);
  function evidence(meeting, { myName = "" } = {}) {
    const caps = (meeting.captions || []).filter((c) => c.name && !isIconText(c.name) && !isMe(c.name, myName));
    const all = (meeting.captions || []).filter((c) => c.name && !isIconText(c.name));
    const out = /* @__PURE__ */ new Map();
    for (const s of meeting.voiceSegs || []) {
      const mine = caps.filter((c) => c.t - LEARN.lead <= s.t0 && (c.t2 ?? c.t) + LEARN.tail >= s.t1);
      if (new Set(mine.map((c) => norm(c.name))).size !== 1) continue;
      const who = norm(mine[0].name);
      const crowded = all.some((c) => norm(c.name) !== who && c.t - LEARN.lead - LEARN.clear <= s.t1 && (c.t2 ?? c.t) + LEARN.tail + LEARN.clear >= s.t0);
      if (crowded) continue;
      if (!out.has(who)) out.set(who, { name: mine[0].name, segs: [] });
      out.get(who).segs.push(s);
    }
    return out;
  }
  function cleaned(segs) {
    let vecs = segs.map((s) => ({ s, v: unpack(s.e) }));
    for (let pass = 0; pass < 2 && vecs.length >= LEARN.minPieces; pass++) {
      const c = mean(vecs.map((x) => x.v));
      const kept = vecs.filter((x) => cosine(x.v, c) >= LEARN.outlier);
      if (kept.length === vecs.length) break;
      vecs = kept;
    }
    return vecs;
  }
  function learnFromMeeting(meeting, people, { myName = "" } = {}) {
    const report = { meeting: meeting.id, learned: [], skipped: [] };
    if (!meeting?.voiceSegs?.length || !meeting?.captions?.length) {
      report.skipped.push({ why: !meeting?.captions?.length ? "no captions were read in this meeting" : "no voice pieces were recorded" });
      return { list: people, changed: false, report };
    }
    const ev = evidence(meeting, { myName });
    const found = [];
    for (const [key2, { name, segs }] of ev) {
      const vecs = cleaned(segs);
      const secs = vecs.reduce((a, x) => a + (x.s.t1 - x.s.t0), 0);
      if (vecs.length < LEARN.minPieces || secs < LEARN.minSecs) {
        report.skipped.push({ name, why: `only ${vecs.length} clean pieces (${secs.toFixed(0)} s)` });
        continue;
      }
      found.push({ key: key2, name, vecs, secs, centroid: mean(vecs.map((x) => x.v)) });
    }
    const bad = /* @__PURE__ */ new Set();
    for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) if (cosine(found[i].centroid, found[j].centroid) >= LEARN.twin) bad.add(i), bad.add(j);
    let list = [...people];
    found.forEach((f, i) => {
      if (bad.has(i)) {
        report.skipped.push({ name: f.name, why: "another speaker in this meeting sounded the same, so it was unclear who was who" });
        return;
      }
      const idx = list.findIndex((p) => norm(p.name) === f.key);
      const existing = idx >= 0 ? list[idx] : null;
      if (existing && !existing.auto) {
        report.skipped.push({ name: f.name, why: "you recorded this voice yourself, so it is left as it is" });
        return;
      }
      const rival = list.find((p) => p !== existing && (!p.auto || p.ready) && cosine(unpack(p.centroid), f.centroid) >= LEARN.twin && norm(p.name) !== f.key);
      if (rival) {
        report.skipped.push({ name: f.name, why: `sounds the same as ${rival.name}, so it was not learned` });
        return;
      }
      if (existing?.learnedFrom?.includes(meeting.id)) return;
      const step = Math.max(1, Math.floor(f.vecs.length / LEARN.keep));
      const fresh = f.vecs.filter((_, k) => k % step === 0).map((x) => pack(x.v)).slice(0, LEARN.keep);
      let rec;
      if (existing) {
        const w = existing.secs || 1;
        const c = mean([scale(unpack(existing.centroid), w), scale(f.centroid, f.secs)]);
        rec = { ...existing, centroid: pack(c), windows: [...existing.windows || [], ...fresh].slice(-LEARN.keep * 2), secs: Math.round(w + f.secs), meetings: (existing.meetings || 1) + 1, learnedFrom: [...existing.learnedFrom || [], meeting.id].slice(-50), updated: Date.now() };
      } else {
        rec = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: f.name, lang: "free", langs: ["free"], centroid: pack(f.centroid), windows: fresh, secs: Math.round(f.secs), meetings: 1, auto: true, learnedFrom: [meeting.id], created: Date.now() };
      }
      rec.ready = rec.secs >= LEARN.readySecs && rec.meetings >= LEARN.readyMeetings;
      if (existing) list[idx] = rec;
      else list = [...list, rec];
      report.learned.push({ name: f.name, secs: Math.round(f.secs), total: rec.secs, ready: rec.ready, isNew: !existing });
    });
    return { list, changed: report.learned.length > 0, report };
  }
  var scale = (v, k) => Float32Array.from(v, (x) => x * k);

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
    otherSites: true,
    // use the page features (amber dot, mute follow, auto-stop) on Zoom, Teams, Webex and other meeting apps
    voiceOn: false,
    // recognise who is speaking, using voices enrolled in Settings
    voiceLearn: false,
    // learn voices on its own from Meet's captions (needs captions read) and fingerprints of the meeting
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
    const { settings, learned, voices } = await chrome.storage.local.get(["settings", "learned", "voices"]);
    const learnedNames = Object.entries(learned?.names || {}).sort((a, b) => a[1] - b[1]).map(([n]) => n).slice(-80);
    return { ...DEFAULTS, ...settings || {}, learnedNames, voices: voices || [] };
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
  async function setSetting(patch) {
    const { settings } = await chrome.storage.local.get("settings");
    const { learnedNames, voices, ...clean } = patch;
    await chrome.storage.local.set({ settings: { ...settings || {}, ...clean } });
  }
  async function saveVoices(list) {
    await chrome.storage.local.set({ voices: list });
  }

  // src/background.js
  chrome.runtime.onInstalled.addListener((d) => {
    if (d.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?restart=1") });
  });
  var chain = Promise.resolve();
  var serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {
    });
    return p;
  };
  var mutateState = (fn) => serial(async () => {
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
      fresh = !st.alert || st.alert.kind !== a.kind || Date.now() - st.alert.notifiedAt > 10 * 60 * 1e3;
      return { ...st, alert: { ...a, at: Date.now(), notifiedAt: fresh ? Date.now() : st.alert.notifiedAt } };
    });
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
    await mutateState((st) => st.alert ? { ...st, alert: null } : null);
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
  var starting = false;
  async function start(msg) {
    if (starting) return { ok: false, error: "A recording is already starting." };
    starting = true;
    try {
      return await startInner(msg);
    } finally {
      starting = false;
    }
  }
  async function startInner(msg) {
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
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId: msg.streamId, settings, meetingId: id }).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) {
      await closeOffscreen();
      await updateMeeting(id, (m) => {
        m.endedAt = Date.now();
        m.errors.push(`Start failed: ${r?.error}`);
      });
      return { ok: false, error: r?.error || "Recorder did not start." };
    }
    await mutateState(() => ({ recording: true, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null, meetCode: (msg.url || "").match(MEET_CODE)?.[0] || null }));
    await chrome.storage.session.set({ quietSince: null, heard: false });
    chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["dist/pill.js"] }).catch(() => {
    });
    chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: "#d93025" });
    chrome.action.setBadgeText({ tabId: msg.tabId, text: "REC" });
    return { ok: true };
  }
  async function learnVoices(meetingId) {
    const s = await getSettings();
    if (!s.voiceLearn) return;
    const m = await getMeeting(meetingId);
    if (!m) return;
    const r = learnFromMeeting(m, s.voices || [], { myName: s.myName });
    if (r.changed) await saveVoices(r.list);
    await updateMeeting(meetingId, (mm) => {
      mm.voiceLearn = r.report;
    });
  }
  var stopping = null;
  function stop(opts = {}) {
    stopping ||= (async () => {
      let st;
      await mutateState((cur) => {
        st = cur;
        return cur.recording && !cur.stopping ? { ...cur, stopping: true } : null;
      });
      if (!st?.recording) return { ok: true };
      try {
        await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
      } catch {
      }
      await updateMeeting(st.meetingId, (m) => m.endedAt = Date.now());
      await learnVoices(st.meetingId).catch(() => {
      });
      await closeOffscreen();
      await mutateState(() => ({ recording: false }));
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setBadgeText({ tabId: st.tabId, text: "" }).catch(() => {
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${st.meetingId}`), active: !opts.background });
      return { ok: true };
    })().finally(() => stopping = null);
    return stopping;
  }
  async function applyMic(patch = {}) {
    const { followMeetMute } = await getSettings();
    let eff = false;
    let changed = false;
    let cur = null;
    await mutateState((st) => {
      if (!st.recording || st.stopping) return null;
      cur = { ...st, ...patch };
      eff = !!cur.micWanted && !!cur.mic && !(followMeetMute && cur.meetMuted === true);
      changed = eff !== !!st.micOn;
      return cur;
    });
    if (!cur) return { ok: false };
    let micOn = cur.micOn;
    if (changed) {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "mic", on: eff }).catch(() => null);
      micOn = r?.micOn ?? false;
      await mutateState((st) => st.recording && !st.stopping ? { ...st, micOn } : null);
    }
    return { ok: true, micOn, micWanted: !!cur.micWanted };
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
  var PAGE_MAY = /* @__PURE__ */ new Set(["whoami", "meet-mute", "meet-ended", "meet-snap", "in-call", "pill-state", "mic", "stop", "set-follow", "dismiss-alert"]);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== "bg") return;
    if (sender.id !== chrome.runtime.id) return;
    const ownPage = !sender.tab || (sender.url || "").startsWith(chrome.runtime.getURL(""));
    if (!ownPage && !PAGE_MAY.has(msg.type)) return;
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
        if (Math.max(msg.tab || 0, msg.mic || 0) >= 0.012) {
          await chrome.storage.session.set({ quietSince: now, heard: true });
          return;
        }
        const { quietSince, heard } = await chrome.storage.session.get(["quietSince", "heard"]);
        if (!heard || !quietSince) return;
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
          for (const n of (msg.names || []).filter((x) => !isIconText(x))) {
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
          if (caps.length > 4e3) caps.splice(0, caps.length - 4e3);
        });
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
      // Voice fingerprints of the meeting's speech, made by the recorder. Only fingerprints, never audio.
      "voice-seg": async () => {
        const segs = (msg.segs || []).filter((x) => Number.isFinite(x?.t0) && Number.isFinite(x?.t1) && typeof x.e === "string" && x.e.length < 600).slice(0, 200);
        if (!segs.length) return { ok: false };
        await updateMeeting(msg.meetingId, (m) => {
          const all = m.voiceSegs ||= [];
          all.push(...segs);
          m.voiceModel = "wespeaker-resnet34-lm";
          if (all.length > 12e3) all.splice(0, all.length - 12e3);
        });
        return { ok: true };
      },
      "dismiss-alert": () => clearAlert(),
      "set-follow": async () => {
        await setSetting({ followMeetMute: !!msg.on });
        return applyMic();
      },
      "pill-state": async () => {
        const rec = await getState();
        const { levels } = await chrome.storage.session.get("levels");
        const m = rec.meetingId ? await getMeeting(rec.meetingId) : null;
        return { ok: true, rec, levels: levels || null, counts: { segs: m?.segments.length || 0, errs: m?.errors.length || 0 }, follow: (await getSettings()).followMeetMute !== false, showPill: (await getSettings()).pillOnPage === true, captionMode: (await getSettings()).meetCaptions || "read", otherSites: (await getSettings()).otherSites !== false };
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
