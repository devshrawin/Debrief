(() => {
  // src/wav.js
  function encodeWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (off2, s) => [...s].forEach((c, i) => v.setUint8(off2 + i, c.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const x2 = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, x2 < 0 ? x2 * 32768 : x2 * 32767, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // src/voice/samples.js
  var DB = "debrief-voice";
  var SR = 16e3;
  var CLIP_SEC = 8;
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
  async function tx(store, mode2, fn2) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, mode2);
        const out = fn2(t.objectStore(store));
        t.oncomplete = () => resolve(out && typeof out === "object" && "result" in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
  var putSample = (personId, blob) => tx("samples", "readwrite", (s) => s.put(blob, personId));
  var getSample = (personId) => tx("samples", "readonly", (s) => s.get(personId));
  var hasSample = async (personId) => await tx("samples", "readonly", (s) => s.count(personId)) > 0;
  var deleteSample = (personId) => tx("samples", "readwrite", (s) => s.delete(personId));
  var unnamedKey = (meetingId, firstAt) => `u:${meetingId}:${Math.round(firstAt)}`;
  async function clearAllAudio() {
    await tx("pieces", "readwrite", (s) => s.clear());
    await tx("samples", "readwrite", (s) => s.clear());
  }
  function makeClip(pieces) {
    const gap = new Float32Array(Math.round(SR * 0.3));
    const parts = [];
    let len = 0;
    for (const p of pieces) {
      if (len + p.length > CLIP_SEC * SR && parts.length) break;
      parts.push(p, gap);
      len += p.length + gap.length;
    }
    const out = new Float32Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return encodeWav(out.subarray(0, Math.min(len, CLIP_SEC * SR)), SR);
  }

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
      const k2 = t.toLowerCase();
      if (seen.has(k2)) continue;
      seen.add(k2);
      out.push(t);
    }
    return out;
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
    for (const [k2, v] of Object.entries(AMNEX_PRESET)) if (!next[k2]) next[k2] = v;
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
  async function saveSettings(s) {
    const { learnedNames, voices, ...own } = s;
    await chrome.storage.local.set({ settings: own });
  }
  var key = (id) => `meeting:${id}`;
  async function listMeetings() {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    const r = await chrome.storage.local.get(meetingIds.map(key));
    return meetingIds.map((id) => r[key(id)]).filter(Boolean).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h2 = Math.floor(sec / 3600);
    const m = Math.floor(sec % 3600 / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h2 ? `${h2}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function errorDetail(text) {
    try {
      const j2 = JSON.parse(text);
      const e = Array.isArray(j2) ? j2[0]?.error : j2.error;
      return (typeof e === "string" ? e : e?.message) || j2.err_msg || j2.message || j2.detail || text;
    } catch {
      return text;
    }
  }
  async function setSetting(patch) {
    const { settings } = await chrome.storage.local.get("settings");
    const { learnedNames, voices, ...clean } = patch;
    await chrome.storage.local.set({ settings: { ...settings || {}, ...clean } });
  }
  async function ensureEmailSecret() {
    await ensureMigrated();
    const { settings } = await chrome.storage.local.get("settings");
    if (settings?.emailSecret) return settings.emailSecret;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ settings: { ...settings || {}, emailSecret: secret } });
    return secret;
  }
  async function getVoices() {
    const { voices } = await chrome.storage.local.get("voices");
    return voices || [];
  }
  function plain(v) {
    return JSON.parse(JSON.stringify(v, (_k, x2) => ArrayBuffer.isView(x2) ? Array.from(x2) : x2));
  }
  async function saveVoices(list) {
    await chrome.storage.local.set({ voices: plain(list) });
  }
  async function forgetAllVoices() {
    await chrome.storage.local.remove(["voices", "voiceBlock", "emailNames"]);
    await clearAllAudio().catch(() => {
    });
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    const r = await chrome.storage.local.get(meetingIds.map(key));
    const changed = {};
    for (const id of meetingIds) {
      const m = r[key(id)];
      if (m && (m.voiceSegs || m.voiceModel)) {
        const { voiceSegs, voiceModel, ...rest } = m;
        changed[key(id)] = rest;
      }
    }
    if (Object.keys(changed).length) await chrome.storage.local.set(changed);
    return Object.keys(changed).length;
  }
  async function getBlockedVoices() {
    const { voiceBlock } = await chrome.storage.local.get("voiceBlock");
    return voiceBlock || [];
  }
  async function saveBlockedVoices(list) {
    await chrome.storage.local.set({ voiceBlock: list.slice(-100) });
  }
  var nameQueue = Promise.resolve();

  // src/local.js
  var OLLAMA_BASE = "http://localhost:11434/v1";
  var WHISPER_BASE = "http://localhost:8000/v1";
  function isLocalBase(base) {
    try {
      const h2 = new URL(base).hostname;
      return h2 === "localhost" || h2 === "127.0.0.1" || h2 === "[::1]" || h2.endsWith(".localhost");
    } catch {
      return false;
    }
  }
  function explain(err, status, what = "Ollama") {
    if (status === 403) return `${what} refused the extension. Start it with the environment variable OLLAMA_ORIGINS=chrome-extension://* (see the local models guide), then restart it.`;
    if (status === 404) return `${what} answered but this address is wrong. For Ollama use http://localhost:11434/v1.`;
    if (status) return `${what} answered with HTTP ${status}.`;
    const m = String(err?.message || err || "");
    if (/failed to fetch|networkerror|load failed|connection|refused/i.test(m)) return `Could not reach ${what}. Is it running? For Ollama, start it with "ollama serve", and allow the extension with OLLAMA_ORIGINS=chrome-extension://*.`;
    return `${what}: ${m || "unknown error"}`;
  }
  var origin = (base) => new URL(base).origin;
  async function listOllamaModels(base = OLLAMA_BASE, fetchFn = fetch) {
    let res;
    try {
      res = await fetchFn(`${origin(base)}/api/tags`, { signal: AbortSignal.timeout(6e3) });
    } catch (e) {
      return { ok: false, message: explain(e) };
    }
    if (!res.ok) return { ok: false, message: explain(null, res.status) };
    const j2 = await res.json().catch(() => ({}));
    const models = (j2.models || []).map((m) => ({ name: m.name, sizeGB: Math.round((m.size || 0) / 1e9 * 10) / 10 }));
    if (!models.length) return { ok: false, message: "Ollama is running but has no models yet. Install one, for example: ollama pull gemma3" };
    return { ok: true, models };
  }
  async function ollamaContext(model, base = OLLAMA_BASE, fetchFn = fetch) {
    try {
      const res = await fetchFn(`${origin(base)}/api/show`, { method: "POST", body: JSON.stringify({ model, name: model }), signal: AbortSignal.timeout(6e3) });
      if (!res.ok) return null;
      const j2 = await res.json();
      const set = Number((String(j2.parameters || "").match(/num_ctx\s+(\d+)/) || [])[1]);
      const max = Object.entries(j2.model_info || {}).find(([k2]) => k2.endsWith(".context_length"))?.[1];
      return { configured: set || null, max: max ? Number(max) : null };
    } catch {
      return null;
    }
  }
  var wordsForContext = (tokens) => Math.max(500, Math.floor(tokens * 0.45));
  function contextAdvice(ctx, transcriptWords = 9e3) {
    if (!ctx) return "";
    const have = ctx.configured || 4096;
    const need = Math.ceil(transcriptWords / 0.45);
    if (have >= need) return `Context length ${have} tokens is enough for about ${wordsForContext(have)} words of transcript.`;
    return `Context length is ${ctx.configured ? ctx.configured : "Ollama's default (about 4096)"} tokens, enough for roughly ${wordsForContext(have)} words. A one-hour meeting can reach ${transcriptWords} words, and Ollama silently cuts off what does not fit. Set OLLAMA_CONTEXT_LENGTH=16384 (or more) and restart Ollama.`;
  }

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
  function learnLimit(text) {
    const s = String(text || "");
    const limit = Number((s.match(/limit:\s*(\d+)/i) || [])[1]);
    const model = (s.match(/model:\s*([\w.-]+)/i) || [])[1];
    return limit && model ? { model, limit } : null;
  }
  function parseLimits(text) {
    const out = {};
    for (const line of String(text || "").split(/\n/)) {
      const m = line.match(/^\s*([\w.:-]+)\s*[=:]\s*(\d+)\s*$/);
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  }
  var sink = { fn: null };
  function record(entry) {
    try {
      if (sink.fn) return sink.fn(entry);
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ target: "bg", type: "usage", entry }).catch(() => {
        });
      }
    } catch {
    }
  }
  function parsePrices(text) {
    const out = {};
    for (const line of String(text || "").split(/\n/)) {
      const m = line.match(/^\s*([\w.:-]+)\s*[=:]\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
      if (m) out[m[1]] = { in: Number(m[2]), out: Number(m[3]) };
    }
    return out;
  }
  function estimateCost(rows, prices) {
    let total = 0;
    let priced = false;
    for (const r of rows) {
      const p = prices[r.model];
      if (!p) continue;
      priced = true;
      total += r.tin / 1e6 * p.in + r.tout / 1e6 * p.out;
    }
    return priced ? total : null;
  }
  var PAID_DEFAULTS = { stt: { in: 1, out: 2.5 }, llm: { in: 0.3, out: 2.5 } };
  function paidCost(row, prices = {}) {
    if (row.provider === "ollama" || row.provider === "whisper" || row.provider === "local") return { usd: 0, assumed: false };
    const own = prices[row.model];
    const p = own || (row.provider === "gemini" ? PAID_DEFAULTS[row.kind] : null);
    if (!p) return { usd: null, assumed: false };
    return { usd: (row.tin || 0) / 1e6 * p.in + (row.tout || 0) / 1e6 * p.out, assumed: !own };
  }
  function paidTotal(rows, prices = {}) {
    let usd = 0;
    let assumed = false;
    let unknown = 0;
    for (const r of rows) {
      const c = paidCost(r, prices);
      if (c.usd == null) unknown++;
      else {
        usd += c.usd;
        assumed ||= c.assumed;
      }
    }
    return { usd, assumed, unknown };
  }
  var DEFAULT_USD_INR = 88;
  var rate = (v) => Number(v) > 0 ? Number(v) : DEFAULT_USD_INR;
  function rupees(usd, usdInr = DEFAULT_USD_INR) {
    const v = usd * rate(usdInr);
    return `\u20B9${v.toLocaleString("en-IN", { minimumFractionDigits: v < 100 ? 2 : 0, maximumFractionDigits: v < 100 ? 2 : 0 })}`;
  }
  function nextQuotaReset(now = Date.now()) {
    const today = dayKey(new Date(now));
    for (let t = now + 6e4; t < now + 26 * 36e5; t += 6e4) if (dayKey(new Date(t)) !== today) return t;
    return now + 12 * 36e5;
  }
  function istClock(ms, now = Date.now()) {
    const f = (opts) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...opts });
    const time = f({ hour: "numeric", minute: "2-digit", hour12: true }).format(ms).replace(/\s?([ap])m/i, (m, c) => ` ${c.toLowerCase()}m`);
    const sameDay = f({ year: "numeric", month: "2-digit", day: "2-digit" }).format(ms) === f({ year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return `${sameDay ? "" : `${f({ weekday: "short" }).format(ms)} `}${time} IST`;
  }

  // src/gemini.js
  var FALLBACK_STATUS = (s) => s === 400 || s === 401 || s === 403 || s === 429 || s >= 500;
  var cool = /* @__PURE__ */ new Map();
  var coolLoaded = 0;
  async function loadCool() {
    if (Date.now() - coolLoaded < 5e3) return;
    coolLoaded = Date.now();
    try {
      const { modelCooldown } = await chrome.storage.local.get("modelCooldown");
      for (const [m, until] of Object.entries(modelCooldown || {})) if (until > (cool.get(m) || 0)) cool.set(m, until);
    } catch {
    }
  }
  var untilPacificMidnight = (now) => nextQuotaReset(now);
  function cooldownFor(text, now = Date.now()) {
    const t = String(text || "");
    if (/PerDay|per day|daily/i.test(t)) return untilPacificMidnight(now);
    const secs = Number((t.match(/retry in\s*([\d.]+)\s*s/i) || [])[1]);
    return now + Math.min(15 * 6e4, (secs > 0 ? secs + 2 : 60) * 1e3);
  }
  function coolDown(model, until) {
    cool.set(model, until);
    try {
      chrome.storage.local.get("modelCooldown").then(({ modelCooldown }) => {
        const keep = Object.fromEntries(Object.entries({ ...modelCooldown || {}, [model]: until }).filter(([, u]) => u > Date.now()));
        chrome.storage.local.set({ modelCooldown: keep });
      });
    } catch {
    }
  }
  var coolingNow = (model, now = Date.now()) => (cool.get(model) || 0) > now;
  async function usable(models) {
    await loadCool();
    const ok = models.filter((m) => !coolingNow(m));
    return ok.length ? ok : models;
  }
  function note(url, res, meta) {
    const model = (url.match(/models\/([^:/?]+)/) || [])[1] || "-";
    const e = { provider: "gemini", model, kind: meta.kind || (/stream/i.test(url) ? "llm" : "stt"), req: 1 };
    if (res && res.ok) return record(e);
    e.fail = true;
    e.rl = res?.status === 429;
    if (!res) return record(e);
    res.clone().text().then((t) => {
      if (e.rl && model !== "-") coolDown(model, cooldownFor(t));
      record({ ...e, learned: learnLimit(t) });
    }, () => record(e));
  }
  async function geminiFetch(url, init, settings, meta = {}) {
    let res;
    try {
      res = await geminiFetchInner(url, init, settings);
    } catch (e) {
      note(url, null, meta);
      throw e;
    }
    note(url, res, meta);
    return res;
  }
  var keyOrder = (settings) => [settings.geminiKey, settings.geminiKey2, ...settings.geminiBackups || []].filter(Boolean);
  async function geminiFetchInner(url, init, settings) {
    const keys = keyOrder(settings);
    const call = (key2) => fetch(url, { ...init, headers: { ...init.headers, "x-goog-api-key": key2 } });
    let res = null;
    for (let i = 0; i < keys.length; i++) {
      const last = i === keys.length - 1;
      res = await call(keys[i]).catch((e) => {
        if (last || e.name === "AbortError") throw e;
        return null;
      });
      if (last || res && (res.ok || !FALLBACK_STATUS(res.status))) return res;
    }
    return res;
  }
  var GENERAL_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"];
  var MODEL_STATUS = (s) => s === 404 || s === 429 || s >= 500;
  var modelChain = (primary) => [...new Set([primary, ...GENERAL_FALLBACKS].filter(Boolean))];
  async function geminiChainFetch(models, urlFor, init, settings, meta = {}) {
    let last, lastErr;
    for (const m of await usable(models)) {
      try {
        const res = await geminiFetch(urlFor(m), init, settings, meta);
        if (res.ok || !MODEL_STATUS(res.status)) return { res, model: m };
        last = { res, model: m };
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;
      }
    }
    if (last) return last;
    throw lastErr;
  }

  // src/llm.js
  var MODERN_CLAUDE = /^claude-(opus-5|fable-5|sonnet-5-5)/;
  async function anthropic({ settings, system, user, onText, signal, temperature }) {
    const model = settings.anthropicModel;
    const modern = MODERN_CLAUDE.test(model);
    const headers = {
      "content-type": "application/json",
      "x-api-key": settings.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    const body = { model, max_tokens: 32e3, system, messages: [{ role: "user", content: user }], stream: true };
    if (modern) {
      Object.assign(body, { thinking: { type: "adaptive" }, output_config: { effort: "medium" }, fallbacks: "default" });
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    } else if (temperature != null) body.temperature = temperature;
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name !== "AbortError") record({ provider: "anthropic", model, kind: "llm", req: 1, fail: true });
      throw e;
    }
    if (!res.ok) {
      record({ provider: "anthropic", model, kind: "llm", req: 1, fail: true, rl: res.status === 429 });
      throw await httpError(res, "Claude");
    }
    let text = "";
    let tin = 0;
    let tout = 0;
    let stop = "";
    let category = "";
    await readSse(res, (ev) => {
      if (ev.type === "message_start") tin = ev.message?.usage?.input_tokens || 0;
      else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        text += ev.delta.text;
        onText(ev.delta.text);
      } else if (ev.type === "message_delta") {
        stop = ev.delta?.stop_reason || stop;
        category = ev.delta?.stop_details?.category || category;
        tout = ev.usage?.output_tokens ?? tout;
      } else if (ev.type === "error") throw Object.assign(new Error(`Claude: ${ev.error?.message || "stream error"}`), { status: ev.error?.type === "overloaded_error" ? 529 : 500 });
    });
    record({ provider: "anthropic", model, kind: "llm", req: 1, tin, tout });
    if (stop === "refusal") throw new Error(`Claude declined this request${category ? ` (${category})` : ""}.`);
    if (stop === "max_tokens") return `${text}

_(Output hit the length limit and was cut off.)_`;
    return text;
  }
  async function readSse(res, onEvent) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          onEvent(JSON.parse(data));
        } catch {
        }
      }
    }
  }
  async function httpError(res, provider) {
    let detail = "";
    try {
      detail = errorDetail(await res.text()).slice(0, 400);
    } catch {
    }
    return Object.assign(new Error(`${provider} HTTP ${res.status}: ${detail}`), { status: res.status });
  }
  async function openaiCompat({ settings, system, user, onText, signal, temperature }) {
    const headers = { "Content-Type": "application/json" };
    if (settings.oaKey) headers.Authorization = `Bearer ${settings.oaKey}`;
    const res = await fetch(`${settings.oaBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: settings.oaModel,
        stream: true,
        ...temperature != null ? { temperature } : {},
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    record({ provider: "openai", model: settings.oaModel, kind: "llm", req: 1, fail: !res.ok, rl: res.status === 429 });
    if (!res.ok) throw await httpError(res, "LLM");
    let text = "";
    await readSse(res, (ev) => {
      const d = ev.choices?.[0]?.delta?.content;
      if (d) {
        text += d;
        onText(d);
      }
    });
    return text;
  }
  async function gemini({ settings, system, user, onText, signal, temperature }) {
    const urlFor = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`;
    const { res, model } = await geminiChainFetch(modelChain(settings.geminiModel), urlFor, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        ...temperature != null ? { generationConfig: { temperature } } : {}
      })
    }, settings, { kind: "llm" });
    if (!res.ok) throw await httpError(res, "Gemini");
    let text = "";
    let usage = null;
    await readSse(res, (ev) => {
      if (ev.usageMetadata) usage = ev.usageMetadata;
      for (const p of ev.candidates?.[0]?.content?.parts || []) {
        if (p.text && !p.thought) {
          text += p.text;
          onText(p.text);
        }
      }
    });
    if (usage) record({ provider: "gemini", model, kind: "llm", tin: usage.promptTokenCount, tout: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) });
    return text;
  }
  var PROVIDERS = { anthropic, openai: openaiCompat, gemini };
  function generate(opts) {
    const fn2 = PROVIDERS[opts.settings.llmProvider];
    if (!fn2) throw new Error(`Unknown LLM provider ${opts.settings.llmProvider}`);
    return fn2(opts);
  }

  // node_modules/marked/lib/marked.esm.js
  function I() {
    return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
  }
  var y = I();
  function W(l3) {
    y = l3;
  }
  var A = { exec: () => null };
  function C(l3) {
    let e = [];
    return (t) => {
      let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
      return s || (s = l3(n), e[n] = s), s;
    };
  }
  function h(l3, e = "") {
    let t = typeof l3 == "string" ? l3 : l3.source, n = { replace: (s, r) => {
      let o = typeof r == "string" ? r : r.source;
      return o = o.replace(x.caret, "$1"), t = t.replace(s, o), n;
    }, getRegex: () => new RegExp(t, e) };
    return n;
  }
  var _e = ((l3 = "") => {
    try {
      return !!new RegExp("(?<=1)(?<!1)" + l3);
    } catch {
      return false;
    }
  })();
  var x = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l3) => new RegExp(`^( {0,3}${l3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: C((l3) => new RegExp(`^ {0,${l3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: C((l3) => new RegExp(`^ {0,${l3}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: C((l3) => new RegExp(`^ {0,${l3}}(?:\`\`\`|~~~)`)), headingBeginRegex: C((l3) => new RegExp(`^ {0,${l3}}#`)), htmlBeginRegex: C((l3) => new RegExp(`^ {0,${l3}}(?:</?(?:${N})(?: +|$|/?>)|<(?:script|pre|style|textarea|!--))`, "i")), blockquoteBeginRegex: C((l3) => new RegExp(`^ {0,${l3}}>`)) };
  var $e = /^(?:[ \t]*(?:\n|$))+/;
  var Le = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  var ze = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
  var G = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  var Ae = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  var J = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  var ce = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
  var he = h(ce).replace(/bull/g, J).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
  var Ee = h(ce).replace(/bull/g, J).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
  var V = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  var Me = /^[^\n]+/;
  var Y = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
  var Ie = h(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", Y).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
  var Ce = h(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, J).getRegex();
  var N = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
  var ee = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  var Be = h("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", ee).replace("tag", N).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
  var de = (l3) => h(V).replace("hr", G).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", l3).replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", N).getRegex();
  var De = de(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
  var qe = de(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
  var ve = h(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", qe).getRegex();
  var te = { blockquote: ve, code: Le, def: Ie, fences: ze, heading: Ae, hr: G, html: Be, lheading: he, list: Ce, newline: $e, paragraph: De, table: A, text: Me };
  var le = h("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", G).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", N).getRegex();
  var Ze = { ...te, lheading: Ee, table: le, paragraph: h(V).replace("hr", G).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", le).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", N).getRegex() };
  var He = { ...te, html: h(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", ee).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: A, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: h(V).replace("hr", G).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", he).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
  var Ge = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  var Ne = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  var ke = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
  var Qe = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
  var $ = /[\p{P}\p{S}]/u;
  var B = /[\s\p{P}\p{S}]/u;
  var Q = /[^\s\p{P}\p{S}]/u;
  var je = h(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, B).getRegex();
  var Fe = /[\p{Pi}\p{Ps}"']/u;
  var ge = /(?!~)[\p{P}\p{S}]/u;
  var Ue = /(?!~)[\s\p{P}\p{S}]/u;
  var Ke = /(?:[^\s\p{P}\p{S}]|~)/u;
  var We = h(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", _e ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
  var fe = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
  var Xe = h(fe, "u").replace(/punct/g, $).getRegex();
  var Je = h(fe, "u").replace(/punct/g, ge).getRegex();
  var Ve = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
  var Ye = h(Ve, "u").replace(/openQuote/g, Fe).replace(/punct/g, $).getRegex();
  var me = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
  var et = h(me, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
  var tt = h(me, "gu").replace(/notPunctSpace/g, Ke).replace(/punctSpace/g, Ue).replace(/punct/g, ge).getRegex();
  var nt = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
  var rt = h(nt, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
  var st = h("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
  var it = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
  var ot = h(it, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
  var at = h(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, $).getRegex();
  var lt = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
  var ut = h(lt, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
  var pt = h(/\\(punct)/, "gu").replace(/punct/g, $).getRegex();
  var ct = h(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
  var ht = h(ee).replace("(?:-->|$)", "-->").getRegex();
  var dt = h("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", ht).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
  var xe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  var U = h(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", xe).getRegex();
  var kt = h(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", U).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
  var gt = h(/^!?\[(label)\]\[(ref)\]/).replace("label", U).replace("ref", Y).getRegex();
  var ft = h(/^!?\[(ref)\](?:\[\])?/).replace("ref", Y).getRegex();
  var ue = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
  var mt = h(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", xe).getRegex();
  var xt = h("reflink|nolink(?!\\()", "g").replace("reflink", h(/^!?\[(label)\]\[(ref)\]/).replace("label", mt).replace("ref", ue).getRegex()).replace("nolink", h(/^!?\[(ref)\](?:\[\])?/).replace("ref", ue).getRegex()).getRegex();
  var pe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  var bt = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  var Rt = h(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, bt).getRegex();
  var ne = { _backpedal: A, anyPunctuation: pt, autolink: ct, blockSkip: We, br: ke, code: Ne, del: A, delLDelim: A, delRDelim: A, emStrongLDelim: Xe, emStrongRDelimAst: et, emStrongRDelimUnd: st, escape: Ge, link: kt, nolink: ft, punctuation: je, reflink: gt, reflinkSearch: xt, tag: dt, text: Qe, url: A };
  var Tt = { ...ne, emStrongLDelim: Ye, emStrongRDelimAst: rt, emStrongRDelimUnd: ot, link: h(/^!?\[(label)\]\((.*?)\)/).replace("label", U).getRegex(), reflink: h(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", U).getRegex() };
  var X = { ...ne, emStrongRDelimAst: tt, emStrongLDelim: Je, delLDelim: at, delRDelim: ut, url: h(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", Rt).replace("protocol", pe).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: h(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", pe).replace(/emailProtocol/g, /(?:mailto|xmpp):/).getRegex() };
  var Ot = { ...X, br: h(ke).replace("{2,}", "*").getRegex(), text: h(X.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
  var j = { normal: te, gfm: Ze, pedantic: He };
  var D = { normal: ne, gfm: X, breaks: Ot, pedantic: Tt };
  var wt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var be = (l3) => wt[l3];
  function O(l3, e) {
    if (e) {
      if (x.escapeTest.test(l3)) return l3.replace(x.escapeReplace, be);
    } else if (x.escapeTestNoEncode.test(l3)) return l3.replace(x.escapeReplaceNoEncode, be);
    return l3;
  }
  function Re(l3) {
    return l3.replace(x.numericCharacterReference, (e, t, n) => {
      let s = t === void 0 ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
      return s === 0 || s > 1114111 || s >= 55296 && s <= 57343 ? "\uFFFD" : String.fromCodePoint(s);
    });
  }
  function re(l3) {
    try {
      l3 = encodeURI(l3).replace(x.percentDecode, "%");
    } catch {
      return null;
    }
    return l3;
  }
  function se(l3, e) {
    let t = l3.replace(x.findPipe, (r, o, i) => {
      let u = false, a = o;
      for (; --a >= 0 && i[a] === "\\"; ) u = !u;
      return u ? "|" : " |";
    }), n = t.split(x.splitPipe), s = 0;
    if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
    else for (; n.length < e; ) n.push("");
    for (; s < n.length; s++) n[s] = n[s].trim().replace(x.slashPipe, "|");
    return n;
  }
  function L(l3, e, t) {
    let n = l3.length;
    if (n === 0) return "";
    let s = 0;
    for (; s < n; ) {
      let r = l3.charAt(n - s - 1);
      if (r === e && !t) s++;
      else if (r !== e && t) s++;
      else break;
    }
    return l3.slice(0, n - s);
  }
  function ie(l3) {
    let e = l3.split(`
`), t = e.length - 1;
    for (; t >= 0 && x.blankLine.test(e[t]); ) t--;
    return e.length - t <= 2 ? l3 : e.slice(0, t + 1).join(`
`);
  }
  function q(l3) {
    return l3.trim().toLowerCase().toUpperCase().toLowerCase();
  }
  function Te(l3, e) {
    if (l3.indexOf(e[1]) === -1) return -1;
    let t = 0;
    for (let n = 0; n < l3.length; n++) if (l3[n] === "\\") n++;
    else if (l3[n] === e[0]) t++;
    else if (l3[n] === e[1] && (t--, t < 0)) return n;
    return t > 0 ? -2 : -1;
  }
  function oe(l3, e = 0) {
    let t = e, n = "";
    for (let s of l3) if (s === "	") {
      let r = 4 - t % 4;
      n += " ".repeat(r), t += r;
    } else n += s, t++;
    return n;
  }
  function Oe(l3, e, t, n, s) {
    let r = e.href, o = e.title || null, i = l3[1].replace(s.other.outputLinkReplace, "$1"), u = l3[0].charAt(0) === "!";
    n.state.inLink = true;
    let a = n.state.linkEmitted, p = n.state.inRawBlock;
    n.state.linkEmitted = false;
    let c = n.inlineTokens(i), d = n.state.linkEmitted;
    if (n.state.linkEmitted = a, n.state.inLink = false, !u) {
      if (d) {
        n.state.inRawBlock = p;
        return;
      }
      n.state.linkEmitted = true;
    }
    return { type: u ? "image" : "link", raw: t, href: r, title: o, text: i, tokens: c };
  }
  function yt(l3, e, t) {
    let n = l3.match(t.other.indentCodeCompensation);
    if (n === null) return e;
    let s = n[1];
    return e.split(`
`).map((r) => {
      let o = r.match(t.other.beginningSpace);
      if (o === null) return r;
      let [i] = o;
      return r.slice(Math.min(i.length, s.length));
    }).join(`
`);
  }
  function we(l3, e, t, n) {
    if (!e.includes("<")) return false;
    for (let s = 0; s < e.length; s++) {
      if (e[s] === "\\") {
        s++;
        continue;
      }
      if (e[s] === "`") {
        let i = n.inline.code.exec(e.slice(s));
        if (i) {
          s += i[0].length - 1;
          continue;
        }
      }
      if (e[s] !== "<") continue;
      let r = l3.slice(t + s), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
      if (o) {
        if (o[0].length > e.length - s) return true;
        s += o[0].length - 1;
      }
    }
    return false;
  }
  var P = class {
    options;
    rules;
    lexer;
    constructor(e) {
      this.options = e || y;
    }
    space(e) {
      let t = this.rules.block.newline.exec(e);
      if (t && t[0].length > 0) return { type: "space", raw: t[0] };
    }
    code(e) {
      let t = this.rules.block.code.exec(e);
      if (t) {
        let n = this.options.pedantic ? t[0] : ie(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
        return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
      }
    }
    fences(e) {
      let t = this.rules.block.fences.exec(e);
      if (t) {
        let n = t[0], s = yt(n, t[3] || "", this.rules);
        return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
      }
    }
    heading(e) {
      let t = this.rules.block.heading.exec(e);
      if (t) {
        let n = t[2].trim();
        if (this.rules.other.endingHash.test(n)) {
          let s = L(n, "#");
          (this.options.pedantic || !s || this.rules.other.endingSpaceTabChar.test(s)) && (n = s.trim());
        }
        return { type: "heading", raw: L(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
      }
    }
    hr(e) {
      let t = this.rules.block.hr.exec(e);
      if (t) return { type: "hr", raw: L(t[0], `
`) };
    }
    blockquote(e) {
      let t = this.rules.block.blockquote.exec(e);
      if (t) {
        let n = L(t[0], `
`).split(`
`), s = "", r = "", o = [];
        for (; n.length > 0; ) {
          let i = false, u = [], a;
          for (a = 0; a < n.length; a++) if (this.rules.other.blockquoteStart.test(n[a])) u.push(n[a]), i = true;
          else if (!i) u.push(n[a]);
          else break;
          n = n.slice(a);
          let p = u.join(`
`), c = p.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
          s = s ? `${s}
${p}` : p, r = r ? `${r}
${c}` : c;
          let d = this.lexer.state.top;
          if (this.lexer.state.top = true, this.lexer.blockTokens(c, o, true), this.lexer.state.top = d, n.length === 0) break;
          let m = o.at(-1);
          if (m?.type === "code") break;
          if (m?.type === "blockquote") {
            let b = m, g = n.join(`
`), w = b.raw + `
` + g.replace(this.rules.other.blockquoteSetextReplace2, ""), f = this.blockquote(w);
            o[o.length - 1] = f;
            let M = w.substring(f.raw.length).replace(/^\n/, ""), v = M ? M.split(`
`).length : 0, Z = v ? n.slice(0, -v) : n;
            Z.length > 0 && (s = `${s}
${Z.join(`
`)}`), r = r.substring(0, r.length - b.text.length) + f.text;
            break;
          } else if (m?.type === "list") {
            let b = m, g = b.raw + `
` + n.join(`
`), w = this.list(g);
            o[o.length - 1] = w, s = s.substring(0, s.length - m.raw.length) + w.raw, r = r.substring(0, r.length - b.raw.length) + w.raw, n = g.substring(o.at(-1).raw.length).split(`
`);
            continue;
          }
        }
        return { type: "blockquote", raw: s, tokens: o, text: r };
      }
    }
    list(e) {
      let t = this.rules.block.list.exec(e);
      if (t) {
        let n = t[1].trim(), s = n.length > 1, r = { type: "list", raw: "", ordered: s, start: s ? +n.slice(0, -1) : "", loose: false, items: [] };
        n = s ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = s ? n : "[*+-]");
        let o = this.rules.other.listItemRegex(n), i = false;
        for (; e; ) {
          let a = false, p = "", c = "";
          if (!(t = o.exec(e)) || this.rules.block.hr.test(e)) break;
          p = t[0], e = e.substring(p.length);
          let d = t[2].split(`
`, 1)[0], m = t[1].length, b = this.options.pedantic ? oe(d, m) : d.replace(this.rules.other.leadingSpaceTab, (M) => oe(M, m)), g = e.split(`
`, 1)[0], w = !b.trim(), f = 0;
          if (this.options.pedantic ? (f = 2, c = b.trimStart()) : w ? f = m + 1 : (f = b.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, c = b.slice(f), f += m), w && this.rules.other.blankLine.test(g) && (p += g + `
`, e = e.substring(g.length + 1), a = true), !a) {
            let M = this.rules.other.nextBulletRegex(f), v = this.rules.other.hrRegex(f), Z = this.rules.other.fencesBeginRegex(f), ae = this.rules.other.headingBeginRegex(f), ye = this.rules.other.htmlBeginRegex(f), Pe = this.rules.other.blockquoteBeginRegex(f);
            for (; e; ) {
              let K = e.split(`
`, 1)[0], H;
              if (g = K, this.options.pedantic ? (g = g.replace(this.rules.other.listReplaceNesting, "  "), H = g) : H = g.replace(this.rules.other.leadingSpaceTab, (Se) => Se.replace(this.rules.other.tabCharGlobal, "    ")), Z.test(g) || ae.test(g) || ye.test(g) || Pe.test(g) || M.test(g) || v.test(g)) break;
              if (H.search(this.rules.other.nonSpaceChar) >= f || !g.trim()) c += `
` + H.slice(f);
              else {
                if (w || b.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || Z.test(b) || ae.test(b) || v.test(b)) break;
                c += `
` + g;
              }
              w = !g.trim(), p += K + `
`, e = e.substring(K.length + 1), b = H.slice(f);
            }
          }
          r.loose || (i ? r.loose = true : this.rules.other.doubleBlankLine.test(p) && (i = true)), r.items.push({ type: "list_item", raw: p, task: !!this.options.gfm && this.rules.other.listIsTask.test(c), loose: false, text: c, tokens: [] }), r.raw += p;
        }
        let u = r.items.at(-1);
        if (u) u.raw = u.raw.trimEnd(), u.text = u.text.trimEnd();
        else return;
        r.raw = r.raw.trimEnd();
        for (let a of r.items) if (this.lexer.state.top = false, a.tokens = this.lexer.blockTokens(a.text, []), !r.loose) {
          let p = a.tokens.filter((d) => d.type === "space"), c = p.length > 0 && p.some((d) => this.rules.other.anyLine.test(d.raw));
          r.loose = c;
        }
        for (let a of r.items) {
          let p = a.tokens[0];
          if (a.task && (p?.type === "text" || p?.type === "paragraph")) {
            a.text = a.text.replace(this.rules.other.listReplaceTask, ""), p.raw = p.raw.replace(this.rules.other.listReplaceTask, ""), p.text = p.text.replace(this.rules.other.listReplaceTask, "");
            for (let d = this.lexer.inlineQueue.length - 1; d >= 0; d--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[d].src)) {
              this.lexer.inlineQueue[d].src = this.lexer.inlineQueue[d].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
            let c = this.rules.other.listTaskCheckbox.exec(a.raw);
            if (c) {
              let d = { type: "checkbox", raw: c[0] + " ", checked: c[0] !== "[ ]" };
              a.checked = d.checked, r.loose ? a.tokens[0] && ["paragraph", "text"].includes(a.tokens[0].type) && "tokens" in a.tokens[0] && a.tokens[0].tokens ? (a.tokens[0].raw = d.raw + a.tokens[0].raw, a.tokens[0].text = d.raw + a.tokens[0].text, a.tokens[0].tokens.unshift(d)) : a.tokens.unshift({ type: "paragraph", raw: d.raw, text: d.raw, tokens: [d] }) : a.tokens.unshift(d);
            }
          } else a.task && (a.task = false);
        }
        if (r.loose) for (let a of r.items) {
          a.loose = true;
          for (let p of a.tokens) p.type === "text" && (p.type = "paragraph");
        }
        return r;
      }
    }
    html(e) {
      let t = this.rules.block.html.exec(e);
      if (t) {
        let n = ie(t[0]);
        return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
      }
    }
    def(e) {
      let t = this.rules.block.def.exec(e);
      if (t) {
        let n = q(t[1]).replace(this.rules.other.multipleSpaceGlobal, " "), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
        return { type: "def", tag: n, raw: L(t[0], `
`), href: s, title: r };
      }
    }
    table(e) {
      let t = this.rules.block.table.exec(e);
      if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
      let n = se(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: L(t[0], `
`), header: [], align: [], rows: [] };
      if (n.length === s.length) {
        for (let i of s) this.rules.other.tableAlignRight.test(i) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(i) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(i) ? o.align.push("left") : o.align.push(null);
        for (let i = 0; i < n.length; i++) o.header.push({ text: n[i], tokens: this.lexer.inline(n[i]), header: true, align: o.align[i] });
        for (let i of r) o.rows.push(se(i, o.header.length).map((u, a) => ({ text: u, tokens: this.lexer.inline(u), header: false, align: o.align[a] })));
        return o;
      }
    }
    lheading(e) {
      let t = this.rules.block.lheading.exec(e);
      if (t) {
        let n = t[1].trim();
        return { type: "heading", raw: L(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
      }
    }
    paragraph(e) {
      let t = this.rules.block.paragraph.exec(e);
      if (t) {
        let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
        return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
      }
    }
    text(e) {
      let t = this.rules.block.text.exec(e);
      if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
    }
    escape(e) {
      let t = this.rules.inline.escape.exec(e);
      if (t) return { type: "escape", raw: t[0], text: t[1] };
    }
    tag(e) {
      let t = this.rules.inline.tag.exec(e);
      if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
    }
    link(e) {
      let t = this.rules.inline.link.exec(e);
      if (t) {
        let n = t[0].charAt(0) === "!" ? 2 : 1;
        if (!this.options.pedantic && we(e, t[1], n, this.rules)) return;
        let s = t[2].trim();
        if (!this.options.pedantic && this.rules.other.startAngleBracket.test(s)) {
          if (!this.rules.other.endAngleBracket.test(s)) return;
          let i = L(s.slice(0, -1), "\\");
          if ((s.length - i.length) % 2 === 0) return;
        } else {
          let i = Te(t[2], "()");
          if (i === -2) return;
          if (i > -1) {
            let a = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
            t[2] = t[2].substring(0, i), t[0] = t[0].substring(0, a).trim(), t[3] = "";
          }
        }
        let r = t[2], o = "";
        if (this.options.pedantic) {
          let i = this.rules.other.pedanticHrefTitle.exec(r);
          i && (r = i[1], o = i[3]);
        } else o = t[3] ? t[3].slice(1, -1) : "";
        return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(s) ? r = r.slice(1) : r = r.slice(1, -1)), Oe(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
      }
    }
    reflink(e, t) {
      let n;
      if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
        let s = n[0].charAt(0) === "!" ? 2 : 1;
        if (!this.options.pedantic && we(e, n[1], s, this.rules)) return;
        let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), o = t[q(r)];
        if (!o) {
          let i = n[0].charAt(0);
          return { type: "text", raw: i, text: i };
        }
        return Oe(n, o, n[0], this.lexer, this.rules);
      }
    }
    emStrong(e, t, n = "") {
      let s = this.rules.inline.emStrongLDelim.exec(e);
      if (!s || !s[1] && !s[2] && !s[3] && !s[4] || s[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
      if (!(s[1] || s[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
        let o = [...s[0]].length - 1, i, u, a = o, p = 0, c = s[0][0], d = n === c, m = c === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
        for (m.lastIndex = 0, t = t.slice(-1 * e.length + o); (s = m.exec(t)) !== null; ) {
          if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i) continue;
          if (u = [...i].length, s[3] || s[4]) {
            a += u;
            continue;
          } else if (s[5] || s[6]) {
            if (o % 3 && !((o + u) % 3)) {
              p += u;
              continue;
            }
            if (d) break;
          }
          if (a -= u, a > 0) continue;
          u = Math.min(u, u + a + p);
          let b = [...s[0]][0].length, g = e.slice(0, o + s.index + b + u);
          if (Math.min(o, u) % 2) {
            let f = g.slice(1, -1);
            return { type: "em", raw: g, text: f, tokens: this.lexer.inlineTokens(f) };
          }
          let w = g.slice(2, -2);
          return { type: "strong", raw: g, text: w, tokens: this.lexer.inlineTokens(w) };
        }
      }
    }
    codespan(e) {
      let t = this.rules.inline.code.exec(e);
      if (t) {
        let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
        return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
      }
    }
    br(e) {
      let t = this.rules.inline.br.exec(e);
      if (t) return { type: "br", raw: t[0] };
    }
    del(e, t, n = "") {
      let s = this.rules.inline.delLDelim.exec(e);
      if (!s) return;
      if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
        let o = [...s[0]].length - 1, i, u, a = o, p = this.rules.inline.delRDelim;
        for (p.lastIndex = 0, t = t.slice(-1 * e.length + o); (s = p.exec(t)) !== null; ) {
          if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (u = [...i].length, u !== o)) continue;
          if (s[3] || s[4]) {
            a += u;
            continue;
          }
          if (a -= u, a > 0) continue;
          u = Math.min(u, u + a);
          let c = [...s[0]][0].length, d = e.slice(0, o + s.index + c + u), m = d.slice(o, -o);
          return { type: "del", raw: d, text: m, tokens: this.lexer.inlineTokens(m) };
        }
      }
    }
    autolink(e) {
      let t = this.rules.inline.autolink.exec(e);
      if (t) {
        let n, s;
        return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
      }
    }
    url(e) {
      let t;
      if (t = this.rules.inline.url.exec(e)) {
        let n, s;
        if (t[2] === "@") n = t[0], s = "mailto:" + n;
        else {
          let r;
          do
            r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
          while (r !== t[0]);
          n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
        }
        return { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
      }
    }
    inlineText(e) {
      let t = this.rules.inline.text.exec(e);
      if (t) {
        let n = this.lexer.state.inRawBlock;
        return { type: "text", raw: t[0], text: n ? t[0] : Re(t[0]), escaped: n };
      }
    }
  };
  var R = class l {
    tokens;
    options;
    state;
    inlineQueue;
    tokenizer;
    constructor(e) {
      this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || y, this.options.tokenizer = this.options.tokenizer || new P(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, top: true };
      let t = { other: x, block: j.normal, inline: D.normal };
      this.options.pedantic ? (t.block = j.pedantic, t.inline = D.pedantic) : this.options.gfm && (t.block = j.gfm, this.options.breaks ? t.inline = D.breaks : t.inline = D.gfm), this.tokenizer.rules = t;
    }
    static get rules() {
      return { block: j, inline: D };
    }
    static lex(e, t) {
      return new l(t).lex(e);
    }
    static lexInline(e, t) {
      return new l(t).inlineTokens(e);
    }
    lex(e) {
      e = e.replace(x.carriageReturn, `
`), this.blockTokens(e, this.tokens);
      for (let t = 0; t < this.inlineQueue.length; t++) {
        let n = this.inlineQueue[t];
        this.inlineTokens(n.src, n.tokens);
      }
      return this.inlineQueue = [], this.tokens;
    }
    blockTokens(e, t = [], n = false) {
      this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(x.tabCharGlobal, "    ").replace(x.spaceLine, ""));
      let s = 1 / 0;
      for (; e; ) {
        if (e.length < s) s = e.length;
        else {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
        let r;
        if (this.options.extensions?.block?.some((i) => (r = i.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
        if (r = this.tokenizer.space(e)) {
          e = e.substring(r.raw.length);
          let i = t.at(-1);
          r.raw.length === 1 && i !== void 0 ? i.raw += `
` : t.push(r);
          continue;
        }
        if (r = this.tokenizer.code(e)) {
          e = e.substring(r.raw.length);
          let i = t.at(-1);
          i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.at(-1).src = i.text) : t.push(r);
          continue;
        }
        if (r = this.tokenizer.fences(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.heading(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.hr(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.blockquote(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.list(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.html(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.def(e)) {
          e = e.substring(r.raw.length);
          let i = t.at(-1);
          i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.raw, this.inlineQueue.at(-1).src = i.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
          continue;
        }
        if (r = this.tokenizer.table(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.lheading(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        let o = e;
        if (this.options.extensions?.startBlock) {
          let i = 1 / 0, u = e.slice(1), a;
          this.options.extensions.startBlock.forEach((p) => {
            a = p.call({ lexer: this }, u), typeof a == "number" && a >= 0 && (i = Math.min(i, a));
          }), i < 1 / 0 && i >= 0 && (o = e.substring(0, i + 1));
        }
        if (this.state.top && (r = this.tokenizer.paragraph(o))) {
          let i = t.at(-1);
          n && i?.type === "paragraph" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
          continue;
        }
        if (r = this.tokenizer.text(e)) {
          e = e.substring(r.raw.length);
          let i = t.at(-1);
          i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r);
          continue;
        }
        if (e) {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
      }
      return this.state.top = true, t;
    }
    inline(e, t = []) {
      return this.inlineQueue.push({ src: e, tokens: t }), t;
    }
    linkInText(e) {
      if (!e.includes("[")) return false;
      let t = this.tokenizer.rules.inline.link;
      for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip)) if (t.test(n[0]) && e.charAt(n.index - 1) !== "!") return true;
      for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
        let s = n[0], r = s.lastIndexOf("[");
        if (!(s.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, q(s.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
      }
      return false;
    }
    inlineTokens(e, t = []) {
      this.tokenizer.lexer = this;
      let n = e;
      if (this.tokens.links && e.includes("[")) {
        let i = this.tokenizer.rules.inline.reflinkSearch, u = (a) => {
          let p = a.lastIndexOf("[");
          if (!Object.hasOwn(this.tokens.links, q(a.slice(p + 1, -1)))) return a;
          if (p > 1 && a.charAt(0) !== "!") {
            let c = a.slice(1, p - 1);
            if (this.linkInText(c)) return "[" + c.replace(i, u) + "][" + "a".repeat(a.length - p - 2) + "]";
          }
          return "[" + "a".repeat(a.length - 2) + "]";
        };
        n = n.replace(i, u);
      }
      n = n.replace(this.tokenizer.rules.inline.anyPunctuation, (i) => "+".repeat(i.length)), n = n.replace(this.tokenizer.rules.inline.blockSkip, (i, u, a) => {
        let p = a ? a.length : 0;
        return i.slice(0, p) + "[" + "a".repeat(i.length - p - 2) + "]";
      }), n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
      let s = false, r = "", o = 1 / 0;
      for (; e; ) {
        if (e.length < o) o = e.length;
        else {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
        s || (r = ""), s = false;
        let i;
        if (this.options.extensions?.inline?.some((a) => (i = a.call({ lexer: this }, e, t)) ? (e = e.substring(i.raw.length), t.push(i), true) : false)) continue;
        if (i = this.tokenizer.escape(e)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.tag(e)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.link(e)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.reflink(e, this.tokens.links)) {
          e = e.substring(i.raw.length);
          let a = t.at(-1);
          i.type === "text" && a?.type === "text" ? (a.raw += i.raw, a.text += i.text) : t.push(i);
          continue;
        }
        if (i = this.tokenizer.emStrong(e, n, r)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.codespan(e)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.br(e)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.del(e, n, r)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (i = this.tokenizer.autolink(e)) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        if (!this.state.inLink && (i = this.tokenizer.url(e))) {
          e = e.substring(i.raw.length), t.push(i);
          continue;
        }
        let u = e;
        if (this.options.extensions?.startInline) {
          let a = 1 / 0, p = e.slice(1), c;
          this.options.extensions.startInline.forEach((d) => {
            c = d.call({ lexer: this }, p), typeof c == "number" && c >= 0 && (a = Math.min(a, c));
          }), a < 1 / 0 && a >= 0 && (u = e.substring(0, a + 1));
        }
        if (i = this.tokenizer.inlineText(u)) {
          e = e.substring(i.raw.length), i.raw.slice(-1) !== "_" && (r = i.raw.slice(-1)), s = true;
          let a = t.at(-1);
          a?.type === "text" ? (a.raw += i.raw, a.text += i.text) : t.push(i);
          continue;
        }
        if (e) {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
      }
      return t;
    }
    infiniteLoopError(e) {
      let t = "Infinite loop on byte: " + e;
      if (this.options.silent) console.error(t);
      else throw new Error(t);
    }
  };
  var S = class {
    options;
    parser;
    constructor(e) {
      this.options = e || y;
    }
    space(e) {
      return "";
    }
    code({ text: e, lang: t, escaped: n }) {
      let s = (t || "").match(x.notSpaceStart)?.[0], r = e ? e.replace(x.endingNewline, "") + `
` : "";
      return s ? '<pre><code class="language-' + O(s) + '">' + (n ? r : O(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : O(r, true)) + `</code></pre>
`;
    }
    blockquote({ tokens: e }) {
      return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
    }
    html({ text: e }) {
      return e;
    }
    def(e) {
      return "";
    }
    heading({ tokens: e, depth: t }) {
      return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
    }
    hr(e) {
      return `<hr>
`;
    }
    list(e) {
      let t = e.ordered, n = e.start, s = "";
      for (let i = 0; i < e.items.length; i++) {
        let u = e.items[i];
        s += this.listitem(u);
      }
      let r = t ? "ol" : "ul", o = t && n !== 1 ? ' start="' + n + '"' : "";
      return "<" + r + o + `>
` + s + "</" + r + `>
`;
    }
    listitem(e) {
      return `<li>${this.parser.parse(e.tokens)}</li>
`;
    }
    checkbox({ checked: e }) {
      return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
    }
    paragraph({ tokens: e }) {
      return `<p>${this.parser.parseInline(e)}</p>
`;
    }
    table(e) {
      let t = "", n = "";
      for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
      t += this.tablerow({ text: n });
      let s = "";
      for (let r = 0; r < e.rows.length; r++) {
        let o = e.rows[r];
        n = "";
        for (let i = 0; i < o.length; i++) n += this.tablecell(o[i]);
        s += this.tablerow({ text: n });
      }
      return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
    }
    tablerow({ text: e }) {
      return `<tr>
${e}</tr>
`;
    }
    tablecell(e) {
      let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
      return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
    }
    strong({ tokens: e }) {
      return `<strong>${this.parser.parseInline(e)}</strong>`;
    }
    em({ tokens: e }) {
      return `<em>${this.parser.parseInline(e)}</em>`;
    }
    codespan({ text: e }) {
      return `<code>${O(e, true)}</code>`;
    }
    br(e) {
      return "<br>";
    }
    del({ tokens: e }) {
      return `<del>${this.parser.parseInline(e)}</del>`;
    }
    link({ href: e, title: t, text: n, tokens: s, autolink: r }) {
      let o = r ? O(n, true) : this.parser.parseInline(s), i = re(e);
      if (i === null) return o;
      e = O(i, r);
      let u = '<a href="' + e + '"';
      return t && (u += ' title="' + O(t) + '"'), u += ">" + o + "</a>", u;
    }
    image({ href: e, title: t, text: n, tokens: s }) {
      s && (n = this.parser.parseInline(s, this.parser.textRenderer));
      let r = re(e);
      if (r === null) return O(n);
      e = r;
      let o = `<img src="${O(e)}" alt="${O(n)}"`;
      return t && (o += ` title="${O(t)}"`), o += ">", o;
    }
    text(e) {
      return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : O(e.text);
    }
  };
  var z = class {
    strong({ text: e }) {
      return e;
    }
    em({ text: e }) {
      return e;
    }
    codespan({ text: e }) {
      return e;
    }
    del({ text: e }) {
      return e;
    }
    html({ text: e }) {
      return e;
    }
    text({ text: e }) {
      return e;
    }
    link({ text: e }) {
      return "" + e;
    }
    image({ text: e }) {
      return "" + e;
    }
    br() {
      return "";
    }
    checkbox({ raw: e }) {
      return e;
    }
  };
  var T = class l2 {
    options;
    renderer;
    textRenderer;
    constructor(e) {
      this.options = e || y, this.options.renderer = this.options.renderer || new S(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new z();
    }
    static parse(e, t) {
      return new l2(t).parse(e);
    }
    static parseInline(e, t) {
      return new l2(t).parseInline(e);
    }
    parse(e) {
      this.renderer.parser = this;
      let t = "";
      for (let n = 0; n < e.length; n++) {
        let s = e[n];
        if (this.options.extensions?.renderers?.[s.type]) {
          let o = s, i = this.options.extensions.renderers[o.type].call({ parser: this }, o);
          if (i !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
            t += i || "";
            continue;
          }
        }
        let r = s;
        switch (r.type) {
          case "space": {
            t += this.renderer.space(r);
            break;
          }
          case "hr": {
            t += this.renderer.hr(r);
            break;
          }
          case "heading": {
            t += this.renderer.heading(r);
            break;
          }
          case "code": {
            t += this.renderer.code(r);
            break;
          }
          case "table": {
            t += this.renderer.table(r);
            break;
          }
          case "blockquote": {
            t += this.renderer.blockquote(r);
            break;
          }
          case "list": {
            t += this.renderer.list(r);
            break;
          }
          case "checkbox": {
            t += this.renderer.checkbox(r);
            break;
          }
          case "html": {
            t += this.renderer.html(r);
            break;
          }
          case "def": {
            t += this.renderer.def(r);
            break;
          }
          case "paragraph": {
            t += this.renderer.paragraph(r);
            break;
          }
          case "text": {
            t += this.renderer.text(r);
            break;
          }
          default: {
            let o = 'Token with "' + r.type + '" type was not found.';
            if (this.options.silent) return console.error(o), "";
            throw new Error(o);
          }
        }
      }
      return t;
    }
    parseInline(e, t = this.renderer) {
      this.renderer.parser = this;
      let n = "";
      for (let s = 0; s < e.length; s++) {
        let r = e[s];
        if (this.options.extensions?.renderers?.[r.type]) {
          let i = this.options.extensions.renderers[r.type].call({ parser: this }, r);
          if (i !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
            n += i || "";
            continue;
          }
        }
        let o = r;
        switch (o.type) {
          case "escape": {
            n += t.text(o);
            break;
          }
          case "html": {
            n += t.html(o);
            break;
          }
          case "link": {
            n += t.link(o);
            break;
          }
          case "image": {
            n += t.image(o);
            break;
          }
          case "checkbox": {
            n += t.checkbox(o);
            break;
          }
          case "strong": {
            n += t.strong(o);
            break;
          }
          case "em": {
            n += t.em(o);
            break;
          }
          case "codespan": {
            n += t.codespan(o);
            break;
          }
          case "br": {
            n += t.br(o);
            break;
          }
          case "del": {
            n += t.del(o);
            break;
          }
          case "text": {
            n += t.text(o);
            break;
          }
          default: {
            let i = 'Token with "' + o.type + '" type was not found.';
            if (this.options.silent) return console.error(i), "";
            throw new Error(i);
          }
        }
      }
      return n;
    }
  };
  var _ = class {
    options;
    block;
    constructor(e) {
      this.options = e || y;
    }
    static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
    static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
    preprocess(e) {
      return e;
    }
    postprocess(e) {
      return e;
    }
    processAllTokens(e) {
      return e;
    }
    emStrongMask(e) {
      return e;
    }
    provideLexer(e = this.block) {
      return e ? R.lex : R.lexInline;
    }
    provideParser(e = this.block) {
      return e ? T.parse : T.parseInline;
    }
  };
  var F = class {
    defaults = I();
    options = this.setOptions;
    parse = this.parseMarkdown(true);
    parseInline = this.parseMarkdown(false);
    Parser = T;
    Renderer = S;
    TextRenderer = z;
    Lexer = R;
    Tokenizer = P;
    Hooks = _;
    constructor(...e) {
      this.use(...e);
    }
    walkTokens(e, t) {
      let n = [];
      for (let s of e) switch (n = n.concat(t.call(this, s)), s.type) {
        case "table": {
          let r = s;
          for (let o of r.header) n = n.concat(this.walkTokens(o.tokens, t));
          for (let o of r.rows) for (let i of o) n = n.concat(this.walkTokens(i.tokens, t));
          break;
        }
        case "list": {
          let r = s;
          n = n.concat(this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = s;
          this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
            let i = r[o].flat(1 / 0);
            n = n.concat(this.walkTokens(i, t));
          }) : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t)));
        }
      }
      return n;
    }
    use(...e) {
      let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
      return e.forEach((n) => {
        let s = { ...n };
        if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
          if (!r.name) throw new Error("extension name required");
          if ("renderer" in r) {
            let o = t.renderers[r.name];
            o ? t.renderers[r.name] = function(...i) {
              let u = r.renderer.apply(this, i);
              return u === false && (u = o.apply(this, i)), u;
            } : t.renderers[r.name] = r.renderer;
          }
          if ("tokenizer" in r) {
            if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
            let o = t[r.level];
            o ? o.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
          }
          "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
        }), s.extensions = t), n.renderer) {
          let r = this.defaults.renderer || new S(this.defaults);
          for (let o in n.renderer) {
            if (!(o in r)) throw new Error(`renderer '${o}' does not exist`);
            if (["options", "parser"].includes(o)) continue;
            let i = o, u = n.renderer[i], a = r[i];
            r[i] = (...p) => {
              let c = u.apply(r, p);
              return c === false && (c = a.apply(r, p)), c || "";
            };
          }
          s.renderer = r;
        }
        if (n.tokenizer) {
          let r = this.defaults.tokenizer || new P(this.defaults);
          for (let o in n.tokenizer) {
            if (!(o in r)) throw new Error(`tokenizer '${o}' does not exist`);
            if (["options", "rules", "lexer"].includes(o)) continue;
            let i = o, u = n.tokenizer[i], a = r[i];
            r[i] = (...p) => {
              let c = u.apply(r, p);
              return c === false && (c = a.apply(r, p)), c;
            };
          }
          s.tokenizer = r;
        }
        if (n.hooks) {
          let r = this.defaults.hooks || new _();
          for (let o in n.hooks) {
            if (!(o in r)) throw new Error(`hook '${o}' does not exist`);
            if (["options", "block"].includes(o)) continue;
            let i = o, u = n.hooks[i], a = r[i];
            _.passThroughHooks.has(o) ? r[i] = (p) => {
              if (this.defaults.async && _.passThroughHooksRespectAsync.has(o)) return (async () => {
                let d = await u.call(r, p);
                return a.call(r, d);
              })();
              let c = u.call(r, p);
              return a.call(r, c);
            } : r[i] = (...p) => {
              if (this.defaults.async) return (async () => {
                let d = await u.apply(r, p);
                return d === false && (d = await a.apply(r, p)), d;
              })();
              let c = u.apply(r, p);
              return c === false && (c = a.apply(r, p)), c;
            };
          }
          s.hooks = r;
        }
        if (n.walkTokens) {
          let r = this.defaults.walkTokens, o = n.walkTokens;
          s.walkTokens = function(i) {
            let u = [];
            return u.push(o.call(this, i)), r && (u = u.concat(r.call(this, i))), u;
          };
        }
        this.defaults = { ...this.defaults, ...s };
      }), this;
    }
    setOptions(e) {
      return this.defaults = { ...this.defaults, ...e }, this;
    }
    lexer(e, t) {
      return R.lex(e, t ?? this.defaults);
    }
    parser(e, t) {
      return T.parse(e, t ?? this.defaults);
    }
    parseMarkdown(e) {
      return (n, s) => {
        let r = { ...s }, o = { ...this.defaults, ...r }, i = this.onError(!!o.silent, !!o.async);
        if (this.defaults.async === true && r.async === false) return i(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
        if (typeof n > "u" || n === null) return i(new Error("marked(): input parameter is undefined or null"));
        if (typeof n != "string") return i(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
        if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async) return (async () => {
          let u = o.hooks ? await o.hooks.preprocess(n) : n, p = await (o.hooks ? await o.hooks.provideLexer(e) : e ? R.lex : R.lexInline)(u, o), c = o.hooks ? await o.hooks.processAllTokens(p) : p;
          o.walkTokens && await Promise.all(this.walkTokens(c, o.walkTokens));
          let m = await (o.hooks ? await o.hooks.provideParser(e) : e ? T.parse : T.parseInline)(c, o);
          return o.hooks ? await o.hooks.postprocess(m) : m;
        })().catch(i);
        try {
          o.hooks && (n = o.hooks.preprocess(n));
          let a = (o.hooks ? o.hooks.provideLexer(e) : e ? R.lex : R.lexInline)(n, o);
          o.hooks && (a = o.hooks.processAllTokens(a)), o.walkTokens && this.walkTokens(a, o.walkTokens);
          let c = (o.hooks ? o.hooks.provideParser(e) : e ? T.parse : T.parseInline)(a, o);
          return o.hooks && (c = o.hooks.postprocess(c)), c;
        } catch (u) {
          return i(u);
        }
      };
    }
    onError(e, t) {
      return (n) => {
        if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
          let s = "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
          return t ? Promise.resolve(s) : s;
        }
        if (t) return Promise.reject(n);
        throw n;
      };
    }
  };
  var E = new F();
  function k(l3, e) {
    return E.parse(l3, e);
  }
  k.options = k.setOptions = function(l3) {
    return E.setOptions(l3), k.defaults = E.defaults, W(k.defaults), k;
  };
  k.getDefaults = I;
  k.defaults = y;
  function Pt(...l3) {
    return E.use(...l3), k.defaults = E.defaults, W(k.defaults), k;
  }
  k.use = Pt;
  k.walkTokens = function(l3, e) {
    return E.walkTokens(l3, e);
  };
  k.parseInline = E.parseInline;
  k.Parser = T;
  k.parser = T.parse;
  k.Renderer = S;
  k.TextRenderer = z;
  k.Lexer = R;
  k.lexer = R.lex;
  k.Tokenizer = P;
  k.Hooks = _;
  k.parse = k;
  var gn = k.options;
  var fn = k.setOptions;
  var mn = k.walkTokens;
  var xn = k.parseInline;
  var Rn = T.parse;
  var Tn = R.lex;

  // src/md.js
  var escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  k.use({
    gfm: true,
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ text }) => escapeHtml(text || ""),
      link(token) {
        const inner = this.parser.parseInline(token.tokens);
        const href = String(token.href || "");
        return /^(https?:\/\/|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${inner}</a>` : inner;
      }
    }
  });

  // src/amnex.js
  var GENERIC_ACCENT = "#334155";
  var ORG = { name: "", confidential: "Confidential", accent: GENERIC_ACCENT, domains: [] };
  var printCss = (confidential = "Confidential") => `/* Debrief: official minutes, A4. Linked from mom.html with media="print"; also inlined in standalone documents. */
@page amx {
  size: A4;
  margin: 22.5mm 12.7mm 25mm 19mm; /* the template: 2.25 cm top, 1.27 cm right, 2.5 cm bottom, 1.9 cm left */
  @bottom-left { content: ""; width: 42mm; border-top: 0.5pt solid ${ORG.accent}; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); width: 42mm; font: 700 12pt Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #000; text-align: right; vertical-align: top; padding-top: 1mm; white-space: nowrap; border-top: 0.5pt solid ${ORG.accent}; }
  @bottom-center { content: "${String(confidential).replace(/["\\\n]/g, " ")}"; font: 9pt Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #000; text-align: center; vertical-align: top; padding-top: 2mm; border-top: 0.5pt solid ${ORG.accent}; }
}
.amx { page: amx; }
.amx, .amx * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.amx table { page-break-inside: auto; }
.amx tr { break-inside: avoid; page-break-inside: avoid; }
.amx thead { display: table-header-group; }
.amx-gap { break-inside: avoid; }
.amx-h1 { break-after: avoid; }
@media print {
  .amx tfoot { display: none; } /* on paper the Confidential line is the page footer above; on screen it closes the document */
  .no-print, .amx-review { display: none !important; }
  body:has(.amx) { background: #fff !important; }
  body:has(.amx) main { max-width: none !important; margin: 0 !important; padding: 0 !important; }
  body:has(.amx) main > header { display: none !important; }
  .amx { max-width: none !important; padding: 0 !important; margin: 0 !important; }
}
`;
  var PRINT_CSS = printCss("Confidential");

  // src/mailer.js
  var WEBAPP_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[\w.-]+\/|a\/[\w.-]+\/macros\/|macros\/)s\/[\w-]+\/exec(?:[?#]|$)/;
  var mailReady = (s) => WEBAPP_URL.test(String(s.emailWebhook || "").trim());
  async function callRelay(payload, settings) {
    if (!mailReady(settings)) throw new Error("Email is not set up: add the Apps Script URL in Settings.");
    const secret = settings.emailSecret || (typeof chrome !== "undefined" && chrome.storage?.local ? await ensureEmailSecret() : "");
    let res;
    try {
      res = await fetch(settings.emailWebhook, {
        method: "POST",
        // text/plain keeps this a "simple" request: Apps Script web apps do not answer CORS preflights.
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        redirect: "follow",
        signal: AbortSignal.timeout(6e4),
        body: JSON.stringify({ ...payload, secret })
      });
    } catch (e) {
      throw new Error(e.name === "TimeoutError" ? "The mail relay did not answer in 60 s." : `Could not reach the mail relay (${e.message}).`);
    }
    const raw = await res.text();
    let j2;
    try {
      j2 = JSON.parse(raw);
    } catch {
      throw new Error(
        /<html|accounts\.google\.com|Sign in/i.test(raw) ? 'The relay asked for a Google sign-in. Redeploy the web app with "Who has access: Anyone".' : `Unexpected reply from the mail relay (HTTP ${res.status}).`
      );
    }
    if (!j2.ok) throw new Error(j2.error || "The mail relay refused the request.");
    return j2;
  }
  function sendMail(mail, settings, who = {}) {
    return callRelay({ to: who.to ?? settings.emailTo ?? "", cc: who.cc || "", bcc: who.bcc || "", ...mail }, settings);
  }
  var EMAIL = /^[^\s@,;<>'"`\\()[\]]+@[^\s@,;<>'"`\\()[\]]+\.[^\s@,;<>'"`\\()[\]]+$/;
  function parseAddresses(text) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const raw of String(text || "").split(/[\s,;]+/)) {
      const a = raw.trim().replace(/^<|>$/g, "");
      if (EMAIL.test(a) && !seen.has(a.toLowerCase())) {
        seen.add(a.toLowerCase());
        out.push(a);
      }
    }
    return out;
  }
  function parseGroups(text) {
    const out = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const [match, rest] = line.split("|");
      if (!rest || !match.trim()) continue;
      const list = parseAddresses(rest);
      if (list.length) out.push({ match: match.trim().toLowerCase(), list });
    }
    return out;
  }
  function allowListLines(addresses, { domains = false } = {}) {
    const q2 = (x2) => `'${String(x2).replace(/'/g, "'")}'`;
    const list = parseAddresses(addresses.join(","));
    if (domains) {
      const ds = [...new Set(list.map((a) => a.split("@")[1].toLowerCase()))];
      return { allowed: "[]", domains: `[${ds.map(q2).join(", ")}]` };
    }
    return { allowed: `[${list.map(q2).join(", ")}]`, domains: "[]" };
  }
  function scriptWithSecret(scriptText, secret) {
    return secret ? scriptText.replace(/const SECRET = '[^']*';/, `const SECRET = '${String(secret).replace(/[^A-Za-z0-9_-]/g, "")}';`) : scriptText;
  }
  function scriptWithAllowList(scriptText, addresses, opts) {
    const { allowed, domains } = allowListLines(addresses, opts);
    return scriptWithSecret(scriptText, opts?.secret).replace(/const ALLOWED = \[[^\]]*\];/, `const ALLOWED = ${allowed};`).replace(/const ALLOWED_DOMAINS = \[[^\]]*\];/, `const ALLOWED_DOMAINS = ${domains};`);
  }

  // apps-script/Code.gs
  var Code_default = `// Debrief mail relay: lets the Debrief extension email your MOM from your own Google account.
//
// Setup:  paste this whole file into a new project at script.google.com, then
//         Deploy > New deployment > Web app > Who has access: Anyone > Deploy.
//         Copy the Web app URL into Debrief > Settings > Email.
//
// After you change this file later: Deploy > Manage deployments > pencil > Version: New version > Deploy.
// The first time (and whenever Google asks for new permissions), pick the function "authorize" in the
// toolbar and press Run once, then allow access. That grants email sending and calendar reading.
//
// Security: "Anyone" can reach the URL, so the script only answers the Debrief install that has its secret.
// Debrief makes up a long random secret on its own (you never type it) and, when you copy the script from
// Settings > Email, puts it on the SECRET line below. Without that line the script falls back to locking itself
// to the first secret it sees; copy the script again from Debrief to close that window. Mail only ever goes to YOUR
// address plus the people you list below. If you reinstall Debrief or use a new browser profile and see
// "locked", run the function "resetSecret" here once and send a test email again.

const ALLOWED = []; // people you want to be able to share minutes with, e.g. ['priya@company.com']
const ALLOWED_DOMAINS = []; // or everyone at a company, e.g. ['company.com']
const SECRET = ''; // filled in by Debrief when you copy this script from Settings > Email; keep this script private

function doGet() {
  return out({ ok: true, message: 'Debrief mail relay is live.', version: 8 });
}

function authorize() {
  CalendarApp.getDefaultCalendar();
  MailApp.getRemainingDailyQuota();
}

// Run this from the editor if Debrief says the relay is locked to another install.
function resetSecret() {
  PropertiesService.getScriptProperties().deleteProperty('secret');
}

function sameText(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// With SECRET set, only that secret works, from the very first request. Without it: the first secret seen is kept
// (trust on first use) and everything after must present the same one.
function authorized(d) {
  const given = typeof d.secret === 'string' ? d.secret : '';
  if (SECRET) return given.length >= 24 && sameText(SECRET, given);
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('secret');
  if (!stored) {
    if (given.length < 24) return false;
    props.setProperty('secret', given);
    return true;
  }
  return sameText(stored, given);
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (!authorized(d)) return out({ ok: false, error: SECRET ? 'This script was set up for a different Debrief install. In Debrief > Settings > Email copy the script again, paste it over this one, save, and deploy a new version.' : 'This script is locked to a different Debrief install. In the script editor run the function resetSecret once, then try again.' });
    if (d.action === 'invitees') return findInvitees(d);

    const me = Session.getEffectiveUser().getEmail();
    const pick = function (list) {
      const wanted = String(list || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      const ok = [];
      const skipped = [];
      wanted.forEach(function (a) {
        (isAllowed(a, me) ? ok : skipped).push(a);
      });
      return { ok: ok, skipped: skipped };
    };
    const to = pick(d.to);
    const cc = pick(d.cc);
    const bcc = pick(d.bcc);
    const recipients = to.ok.length ? to.ok.join(',') : (cc.ok.length || bcc.ok.length ? '' : me);

    const attachments = (d.attachments || []).map(function (a) {
      const name = String(a.name || 'attachment.txt').slice(0, 150);
      // fromHtml: build a PDF from an HTML page. Remote resources are stripped so the page cannot call out.
      if (a.fromHtml) return Utilities.newBlob(stripRemote(a.fromHtml), 'text/html', name.replace(/\\.pdf$/i, '') + '.html').getAs('application/pdf').setName(name);
      return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mime || 'text/plain', name);
    });
    const options = {
      to: recipients || me,
      subject: String(d.subject || 'Debrief MOM').replace(/[\\r\\n]+/g, ' ').slice(0, 250),
      body: String(d.text || ''),
      htmlBody: String(d.html || ''),
      attachments: attachments,
      name: 'Debrief',
      replyTo: me,
    };
    if (cc.ok.length) options.cc = cc.ok.join(',');
    if (bcc.ok.length) options.bcc = bcc.ok.join(',');
    MailApp.sendEmail(options);
    return out({ ok: true, to: options.to, cc: cc.ok, bcc: bcc.ok, skipped: to.skipped.concat(cc.skipped, bcc.skipped) });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function stripRemote(html) {
  return String(html)
    .replace(/<(img|link|script|iframe|object|embed|video|audio|source)\\b[^>]*>/gi, '')
    .replace(/url\\s*\\([^)]*\\)/gi, 'none')
    .replace(/@import[^;]*;/gi, '');
}

function isAllowed(address, me) {
  const a = String(address).trim().toLowerCase();
  if (!/^[^\\s@,;<>"'\`()\\[\\]\\\\]+@[^\\s@,;<>"'\`()\\[\\]\\\\]+\\.[^\\s@,;<>"'\`()\\[\\]\\\\]+$/.test(a) || a.split('@').length !== 2) return false;
  if (a === String(me).toLowerCase()) return true;
  if (ALLOWED.some(function (x) { return String(x).toLowerCase() === a; })) return true;
  const domain = a.split('@')[1];
  return ALLOWED_DOMAINS.some(function (x) { return String(x).toLowerCase() === domain; });
}

// Finds the calendar event for this meeting by its exact Meet code (else by exact title) and returns who
// was invited and what they replied. Only names, emails and replies leave the script, never the event text.
function findInvitees(d) {
  const code = String(d.code || '').toLowerCase();
  const codeOk = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code);
  const startMs = Number(d.start);
  const endMs = Number(d.end);
  if (!(startMs > 0)) return out({ ok: true, found: false, guests: [] });
  const dayMs = 24 * 3600 * 1000;
  const start = new Date(startMs - 45 * 60000);
  const end = new Date(Math.min(isFinite(endMs) && endMs > startMs ? endMs : startMs, startMs + dayMs) + 45 * 60000);
  const title = String(d.title || '').toLowerCase().trim();
  // Meet links added with "Add Google Meet" are often not in the event's location or description, so the code
  // alone misses them. Three tiers: the code, the exact title, then a title that mostly matches.
  const words = function (t) {
    return t.split(/[^a-z0-9\\u0900-\\u097f\\u0d00-\\u0d7f]+/).filter(function (w) { return w.length >= 3; });
  };
  const near = function (a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 6 && b.length >= 6 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return true;
    const wa = words(a);
    const wb = words(b);
    if (wa.length < 2 || wb.length < 2) return false;
    const common = wa.filter(function (w) { return wb.indexOf(w) >= 0; }).length;
    return common / Math.min(wa.length, wb.length) >= 0.67;
  };
  let best = null;
  let bestRank = 9;
  let bestGap = Infinity;
  let how = '';
  CalendarApp.getDefaultCalendar().getEvents(start, end).forEach(function (ev) {
    const where = (ev.getLocation() + ' ' + ev.getDescription()).toLowerCase();
    const gap = Math.abs(ev.getStartTime().getTime() - startMs);
    const t = ev.getTitle().toLowerCase().trim();
    const rank = codeOk && where.indexOf(code) >= 0 ? 0 : title && t === title ? 1 : title && near(t, title) ? 2 : 9;
    if (rank < 9 && (rank < bestRank || (rank === bestRank && gap < bestGap))) {
      best = ev;
      bestRank = rank;
      bestGap = gap;
      how = rank === 0 ? 'code' : rank === 1 ? 'title' : 'similar title';
    }
  });
  if (!best) return out({ ok: true, found: false, guests: [] });
  const status = function (g) {
    const s = String(g.getGuestStatus()).toLowerCase();
    return s.indexOf('owner') >= 0 ? 'owner' : s.indexOf('yes') >= 0 ? 'yes' : s.indexOf('maybe') >= 0 ? 'maybe' : s === 'no' || s.indexOf('.no') >= 0 ? 'no' : 'invited';
  };
  const guests = best.getGuestList(true).map(function (g) {
    return { name: g.getName() || '', email: g.getEmail(), status: status(g) };
  });
  const me = Session.getEffectiveUser().getEmail();
  if (!guests.some(function (g) { return String(g.email).toLowerCase() === String(me).toLowerCase(); })) guests.push({ name: '', email: me, status: 'owner' });
  return out({ ok: true, found: true, how: how, guests: guests });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;

  // src/dictionary.js
  var norm = (s) => String(s || "").toLowerCase().normalize("NFKC").trim();
  var oneLine = (x2) => String(x2 || "").replace(/[\r\n,|]+/g, " ").replace(/\s+/g, " ").trim();
  function learnAlias(text, right, wrong) {
    const r = oneLine(right);
    const w = oneLine(wrong);
    if (!r) return String(text || "");
    const lines = String(text || "").split(/\r?\n/);
    const at2 = lines.findIndex((l3) => {
      const t = l3.trim();
      return t && !t.startsWith("#") && norm(t.split("|")[0]) === norm(r);
    });
    if (at2 < 0) {
      const add = w && norm(w) !== norm(r) ? `${r} | ${w}` : r;
      return [...lines.filter((l3, i) => !(i === lines.length - 1 && !l3.trim())), add].join("\n");
    }
    const [name, rest = ""] = lines[at2].split("|");
    const aliases = rest.split(",").map((a) => a.trim()).filter(Boolean);
    if (w && norm(w) !== norm(r) && !aliases.some((a) => norm(a) === norm(w))) aliases.push(w);
    lines[at2] = aliases.length ? `${name.trim()} | ${aliases.join(", ")}` : name.trim();
    return lines.join("\n");
  }
  var COMMON = new Set("this that then than them they there their these those when what where which while with from have has had will would could should about after again also been being both come did does done each even every just know like made make many more most much must only other over said same some such take them than very well were your into out how its our own put she her him his who why yes yet".split(" "));

  // src/languages.js
  var LANGUAGES = [
    { code: "en", name: "English", bcp: "en-IN", script: "Latin script" },
    { code: "hi", name: "Hindi", bcp: "hi-IN", script: "Devanagari" },
    { code: "ml", name: "Malayalam", bcp: "ml-IN", script: "Malayalam script" },
    { code: "ta", name: "Tamil", bcp: "ta-IN", script: "Tamil script" },
    { code: "te", name: "Telugu", bcp: "te-IN", script: "Telugu script" },
    { code: "kn", name: "Kannada", bcp: "kn-IN", script: "Kannada script" },
    { code: "mr", name: "Marathi", bcp: "mr-IN", script: "Devanagari" },
    { code: "bn", name: "Bengali", bcp: "bn-IN", script: "Bengali script" },
    { code: "gu", name: "Gujarati", bcp: "gu-IN", script: "Gujarati script" },
    { code: "pa", name: "Punjabi", bcp: "pa-IN", script: "Gurmukhi" },
    { code: "or", name: "Odia", bcp: "or-IN", script: "Odia script" },
    { code: "ur", name: "Urdu", bcp: "ur-IN", script: "Urdu (Arabic) script" },
    { code: "es", name: "Spanish", bcp: "es-ES", script: "Latin script" },
    { code: "fr", name: "French", bcp: "fr-FR", script: "Latin script" },
    { code: "de", name: "German", bcp: "de-DE", script: "Latin script" },
    { code: "pt", name: "Portuguese", bcp: "pt-BR", script: "Latin script" },
    { code: "ru", name: "Russian", bcp: "ru-RU", script: "Cyrillic" },
    { code: "ar", name: "Arabic", bcp: "ar-XA", script: "Arabic script" },
    { code: "zh", name: "Chinese (Mandarin)", bcp: "zh-CN", script: "Chinese characters" },
    { code: "ja", name: "Japanese", bcp: "ja-JP", script: "Japanese script" }
  ];
  var BY_CODE = new Map(LANGUAGES.map((l3) => [l3.code, l3]));
  var LEGACY = { auto: ["en", "hi", "ml"], hinglish: ["hi", "en"], malayalam: ["ml", "en"] };
  function chosenLanguages(settings) {
    const list = settings?.meetingLanguages;
    if (Array.isArray(list) && list.length) return list.map((c) => BY_CODE.get(c)).filter(Boolean);
    const legacy = settings?.meetingLanguage;
    return legacy && legacy !== "auto" && LEGACY[legacy] ? LEGACY[legacy].map((c) => BY_CODE.get(c)) : null;
  }
  var minutesLanguageOptions = () => [...LANGUAGES.map((l3) => ({ value: l3.code === "hi" ? "Hindi (Devanagari)" : l3.name, label: l3.code === "hi" ? "Hindi (Devanagari)" : l3.name })), { value: "the same language mix used in the meeting", label: "Same as the meeting" }];
  var names = (langs) => langs.length <= 1 ? langs[0]?.name || "" : `${langs.slice(0, -1).map((l3) => l3.name).join(", ")} and ${langs.at(-1).name}`;

  // src/voice/match.js
  var THRESHOLDS = {
    accept: 0.42,
    // a person must score at least this against the piece of speech
    margin: 0.07,
    // and beat the runner-up by this much, or the piece is "unknown"
    strong: 0.6,
    // at or above this a label is kept even if its neighbours disagree
    mixedShare: 0.6,
    // a sentence needs this share of its speech time from one voice to be labelled
    gap: 2.5
    // seconds: neighbours further apart than this do not vote for each other
  };
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
    for (const x2 of v) n += x2 * x2;
    n = Math.sqrt(n) || 1;
    return Float32Array.from(v, (x2) => x2 / n);
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
  function prepared(person) {
    if (!person._c) {
      person._c = unpack(person.centroid);
      person._w = (person.windows || []).map(unpack);
    }
    return person;
  }
  function personScore(emb, person) {
    const p = prepared(person);
    const c = cosine(emb, p._c);
    const best = p._w.length ? Math.max(...p._w.map((w) => cosine(emb, w))) : c;
    return 0.6 * c + 0.4 * best;
  }
  function classify(emb, people2, th = THRESHOLDS) {
    if (!emb || !people2?.length) return { id: null, name: null, score: 0, margin: 0, why: "no voices enrolled" };
    const scored = people2.map((p) => ({ id: p.id, name: p.name, score: personScore(emb, p) })).sort((a, b) => b.score - a.score);
    const [top, second] = scored;
    const margin = top.score - (second?.score ?? 0);
    if (top.score < th.accept) return { id: null, name: null, score: top.score, margin, best: top.name, why: "too different from everyone enrolled" };
    if (second && margin < th.margin && top.score < th.strong + 0.1) return { id: null, name: null, score: top.score, margin, best: top.name, why: "could be two people (or both talking)" };
    return { id: top.id, name: top.name, score: top.score, margin };
  }
  function clusterVoices(segs, { threshold = 0.55 } = {}) {
    const vecs = segs.map((s) => unpack(s.e));
    let clusters = vecs.map((_2, i) => ({ members: [i] }));
    const sim = (a, b) => {
      let s = 0;
      for (const i of a.members) for (const j2 of b.members) s += cosine(vecs[i], vecs[j2]);
      return s / (a.members.length * b.members.length);
    };
    for (; ; ) {
      let best = -1;
      let pair = null;
      for (let i2 = 0; i2 < clusters.length; i2++) {
        for (let j3 = i2 + 1; j3 < clusters.length; j3++) {
          const s = sim(clusters[i2], clusters[j3]);
          if (s > best) [best, pair] = [s, [i2, j3]];
        }
      }
      if (!pair || best < 1 - threshold) break;
      const [i, j2] = pair;
      clusters[i] = { members: [...clusters[i].members, ...clusters[j2].members] };
      clusters.splice(j2, 1);
    }
    return clusters.map((c) => ({ members: c.members.sort((a, b) => a - b), seconds: c.members.reduce((a, i) => a + (segs[i].t1 - segs[i].t0), 0), centroid: pack(mean(c.members.map((i) => vecs[i]))) })).sort((a, b) => b.seconds - a.seconds);
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
  var scale = (v, k2) => Float32Array.from(v, (x2) => x2 * k2);
  var isAnon = (p) => /^Unnamed voice \d+$/.test(p?.name || "");
  var blockEntry = (p) => ({ name: p.name, centroid: p.centroid });
  function mergePeople(list, fromId, intoId) {
    const from = list.find((p) => p.id === fromId);
    const into = list.find((p) => p.id === intoId);
    if (!from || !into || from.id === into.id) throw new Error("Pick two different voices to merge.");
    if (!from.centroid || !into.centroid) throw new Error("One of these voices has no voice fingerprint, so it cannot be merged. Delete it and let Debrief learn it again.");
    if (unpack(from.centroid).length !== unpack(into.centroid).length) throw new Error("These two voices were made with different speaker models and cannot be merged.");
    const wf = Math.max(1, from.secs || 1);
    const wi = Math.max(1, into.secs || 1);
    const merged = {
      ...into,
      centroid: pack(mean([scale(unpack(into.centroid), wi), scale(unpack(from.centroid), wf)])),
      windows: [...into.windows || [], ...from.windows || []].slice(-LEARN.keep * 2),
      secs: (into.secs || 0) + (from.secs || 0),
      meetings: Math.max(into.meetings || 1, from.meetings || 1),
      langs: [.../* @__PURE__ */ new Set([...into.langs || [into.lang || "en"], ...from.langs || [from.lang || "en"]])],
      learnedFrom: [.../* @__PURE__ */ new Set([...into.learnedFrom || [], ...from.learnedFrom || []])].slice(-50),
      updated: Date.now()
    };
    if (into.auto) merged.ready = merged.secs >= LEARN.readySecs && merged.meetings >= LEARN.readyMeetings;
    return list.filter((p) => p.id !== fromId).map((p) => p.id === intoId ? merged : p);
  }
  var usableVoices = (people2) => (people2 || []).filter((p) => !p.auto || p.ready || p.confirmed);
  function unnamedGroups(meeting, people2, { max = 4, minSecs = 15, cap = 300 } = {}) {
    const usable2 = usableVoices(people2);
    const segs = (meeting.voiceSegs || []).filter((s) => !usable2.length || !classify(unpack(s.e), usable2).id);
    if (segs.length < 4) return [];
    const step = Math.max(1, Math.ceil(segs.length / cap));
    const sample = segs.filter((_2, i) => i % step === 0);
    return clusterVoices(sample).filter((g) => g.seconds * step >= minSecs).slice(0, max).map((g) => ({ seconds: Math.round(g.seconds * step), pieces: g.members.length, centroid: g.centroid, windows: g.members.filter((_2, k2) => k2 % Math.max(1, Math.floor(g.members.length / 8)) === 0).slice(0, 8).map((i) => sample[i].e), at: g.members.slice(0, 3).map((i) => Math.round(sample[i].t0)), segs: g.members.slice(0, 8).map((i) => ({ t0: sample[i].t0, s: sample[i].s })) }));
  }

  // src/voice/client.js
  function createVoiceClient({ workerUrl, modelUrl, wasmPaths, maxQueue = 24 }) {
    const worker = new Worker(workerUrl);
    const pending = /* @__PURE__ */ new Map();
    let nextId = 1;
    let ready2;
    let readyFail;
    const readyP = new Promise((res, rej) => {
      ready2 = res;
      readyFail = rej;
    });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.ready) return ready2();
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.emb);
    };
    worker.onerror = (e) => readyFail(new Error(e.message || "voice worker failed"));
    (async () => {
      try {
        const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
        worker.postMessage({ type: "init", model: bytes, wasmPaths }, [bytes.buffer]);
      } catch (e) {
        readyFail(e);
      }
    })();
    return {
      ready: readyP,
      get backlog() {
        return pending.size;
      },
      // Resolves with a unit-length Float32Array(256), null (too short / dropped), or rejects.
      embed(pcm2) {
        if (pending.size >= maxQueue) return Promise.resolve(null);
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, pcm: pcm2 }, [pcm2.buffer]);
        });
      },
      async drain(ms = 2e4) {
        const end = Date.now() + ms;
        while (pending.size && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      },
      close() {
        worker.terminate();
        for (const p of pending.values()) p.resolve(null);
        pending.clear();
      }
    };
  }

  // src/voice/tracker.js
  var SR2 = 16e3;
  var MIN_SEC = 1.5;
  var MAX_SEC = 4;
  var PAUSE_BLOCKS = 3;
  var VoiceTracker = class {
    // onSegment({ t0, t1, pcm }) is called for each piece. t0 and t1 are seconds since the recording began.
    constructor(onSegment) {
      this.onSegment = onSegment;
      this.floor = -60;
      this.recent = [];
      this.samples = 0;
      this.cur = [];
      this.curStart = 0;
      this.quiet = 0;
      this.speechBlocks = 0;
    }
    push(block) {
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      const db = 10 * Math.log10(sum / block.length + 1e-12);
      this.recent.push(db);
      if (this.recent.length > 117) this.recent.shift();
      const target = [...this.recent].sort((x2, y2) => x2 - y2)[Math.floor((this.recent.length - 1) * 0.2)];
      this.floor = this.recent.length === 1 ? db : Math.min(target, this.floor + 0.3);
      const speech = db > Math.max(this.floor + 9, -52);
      const at2 = this.samples;
      this.samples += block.length;
      if (speech) {
        if (!this.cur.length) this.curStart = at2;
        this.cur.push(block);
        this.speechBlocks++;
        this.quiet = 0;
      } else if (this.cur.length) {
        this.quiet++;
        this.cur.push(block);
        if (this.quiet >= PAUSE_BLOCKS) this.close(true);
      }
      if (this.cur.length && (this.samples - this.curStart) / SR2 >= MAX_SEC) this.close(false);
    }
    close(trimQuiet) {
      const blocks = trimQuiet ? this.cur.slice(0, this.cur.length - this.quiet) : this.cur;
      const speech = this.speechBlocks;
      this.cur = [];
      this.quiet = 0;
      this.speechBlocks = 0;
      const len = blocks.reduce((a, b) => a + b.length, 0);
      if (len / SR2 < MIN_SEC || speech * (blocks[0]?.length || 2048) / len < 0.6) return;
      const pcm2 = new Float32Array(len);
      let o = 0;
      for (const b of blocks) {
        pcm2.set(b, o);
        o += b.length;
      }
      this.onSegment({ t0: this.curStart / SR2, t1: this.curStart / SR2 + len / SR2, pcm: pcm2 });
    }
    flush() {
      if (this.cur.length) this.close(true);
    }
  };

  // src/voice/enrol.js
  var ENROL = {
    targetSec: 20,
    // what the screen asks for
    minSpeechSec: 8,
    // less speech than this and the fingerprint would be unreliable
    minPieces: 4,
    maxWindows: 10,
    // individual fingerprints kept next to the average
    minConsistency: 0.35
    // a piece this unlike the rest (a cough, a second voice) is left out
  };
  var PROMPTS = {
    hi: "\u0915\u0943\u092A\u092F\u093E \u0907\u0938\u0947 \u0905\u092A\u0928\u0940 \u0938\u093E\u092E\u093E\u0928\u094D\u092F \u0917\u0924\u093F \u0914\u0930 \u0906\u0935\u093E\u091C\u093C \u092E\u0947\u0902 \u091C\u093C\u094B\u0930 \u0938\u0947 \u092A\u0922\u093C\u0947\u0902\u0964 \u091C\u092C \u092E\u0902\u0917\u0932\u0935\u093E\u0930 \u0915\u094B \u091F\u0940\u092E \u0915\u0940 \u092C\u0948\u0920\u0915 \u0939\u0941\u0908, \u0924\u092C \u0939\u092E\u0928\u0947 \u0930\u091C\u093F\u0938\u094D\u091F\u094D\u0930\u0947\u0936\u0928 \u0915\u093E \u0921\u0947\u091F\u093E \u0926\u0947\u0916\u093E, \u0939\u0930 \u0938\u094D\u0915\u0940\u092E \u0915\u0940 \u092E\u0948\u092A\u093F\u0902\u0917 \u092B\u093C\u093E\u0907\u0932 \u091C\u093E\u0901\u091A\u0940, \u0914\u0930 \u0924\u092F \u0915\u093F\u092F\u093E \u0915\u093F \u0905\u092A\u0932\u094B\u0921 \u0936\u0941\u0915\u094D\u0930\u0935\u093E\u0930 \u0926\u094B\u092A\u0939\u0930 \u0924\u0915 \u0924\u0948\u092F\u093E\u0930 \u0939\u094B \u091C\u093E\u090F\u0917\u093E\u0964 \u0905\u0917\u0930 \u092A\u093F\u091B\u0932\u0947 \u0939\u092B\u093C\u094D\u0924\u0947 \u0938\u0947 \u0915\u0941\u091B \u092D\u0940 \u0905\u0932\u0917 \u0926\u093F\u0916\u0947, \u0924\u094B \u0915\u0943\u092A\u092F\u093E \u0905\u092D\u0940 \u092C\u0924\u093E\u0907\u090F \u0924\u093E\u0915\u093F \u0930\u093F\u0935\u094D\u092F\u0942 \u0938\u0947 \u092A\u0939\u0932\u0947 \u0909\u0938\u0947 \u0920\u0940\u0915 \u0915\u093F\u092F\u093E \u091C\u093E \u0938\u0915\u0947\u0964 \u0938\u092D\u0940 \u0915\u093E \u0927\u0928\u094D\u092F\u0935\u093E\u0926, \u0906\u091C \u0915\u0947 \u0932\u093F\u090F \u092C\u0938 \u0907\u0924\u0928\u093E \u0939\u0940\u0964",
    free: "Speak naturally for about 20 seconds, in the language you use in meetings (for example, describe what you did yesterday, your plans for this week, or how your team works). Mixing languages the way you normally do is fine.",
    en: "Please read this aloud at your normal pace and volume. When the team met on Tuesday, we reviewed the registration data, checked the mapping file for each scheme, and agreed that the upload would be ready by Friday afternoon. If anything looks different from last week, please tell me now so we can fix it before the review. Thank you everyone, that is all for today.",
    ml: "\u0D26\u0D2F\u0D35\u0D3E\u0D2F\u0D3F \u0D38\u0D3E\u0D27\u0D3E\u0D30\u0D23 \u0D35\u0D47\u0D17\u0D24\u0D4D\u0D24\u0D3F\u0D32\u0D41\u0D02 \u0D36\u0D2C\u0D4D\u0D26\u0D24\u0D4D\u0D24\u0D3F\u0D32\u0D41\u0D02 \u0D07\u0D24\u0D4D \u0D09\u0D31\u0D15\u0D4D\u0D15\u0D46 \u0D35\u0D3E\u0D2F\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15. \u0D1A\u0D4A\u0D35\u0D4D\u0D35\u0D3E\u0D34\u0D4D\u0D1A \u0D1F\u0D40\u0D02 \u0D2F\u0D4B\u0D17\u0D02 \u0D1A\u0D47\u0D7C\u0D28\u0D4D\u0D28\u0D2A\u0D4D\u0D2A\u0D4B\u0D7E \u0D1E\u0D19\u0D4D\u0D19\u0D7E \u0D30\u0D1C\u0D3F\u0D38\u0D4D\u0D1F\u0D4D\u0D30\u0D47\u0D37\u0D7B \u0D35\u0D3F\u0D35\u0D30\u0D19\u0D4D\u0D19\u0D7E \u0D2A\u0D30\u0D3F\u0D36\u0D4B\u0D27\u0D3F\u0D1A\u0D4D\u0D1A\u0D41, \u0D13\u0D30\u0D4B \u0D38\u0D4D\u0D15\u0D40\u0D2E\u0D3F\u0D28\u0D41\u0D2E\u0D41\u0D33\u0D4D\u0D33 \u0D2E\u0D3E\u0D2A\u0D4D\u0D2A\u0D3F\u0D02\u0D17\u0D4D \u0D2B\u0D2F\u0D7D \u0D28\u0D4B\u0D15\u0D4D\u0D15\u0D3F, \u0D35\u0D46\u0D33\u0D4D\u0D33\u0D3F\u0D2F\u0D3E\u0D34\u0D4D\u0D1A \u0D09\u0D1A\u0D4D\u0D1A\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D4D \u0D2E\u0D41\u0D2E\u0D4D\u0D2A\u0D4D \u0D05\u0D2A\u0D4D\u200C\u0D32\u0D4B\u0D21\u0D4D \u0D24\u0D2F\u0D4D\u0D2F\u0D3E\u0D31\u0D3E\u0D15\u0D41\u0D2E\u0D46\u0D28\u0D4D\u0D28\u0D4D \u0D24\u0D40\u0D30\u0D41\u0D2E\u0D3E\u0D28\u0D3F\u0D1A\u0D4D\u0D1A\u0D41. \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E \u0D06\u0D34\u0D4D\u0D1A\u0D2F\u0D3F\u0D7D \u0D28\u0D3F\u0D28\u0D4D\u0D28\u0D4D \u0D0E\u0D28\u0D4D\u0D24\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D32\u0D41\u0D02 \u0D35\u0D4D\u0D2F\u0D24\u0D4D\u0D2F\u0D3E\u0D38\u0D02 \u0D15\u0D23\u0D4D\u0D1F\u0D3E\u0D7D \u0D26\u0D2F\u0D35\u0D3E\u0D2F\u0D3F \u0D07\u0D2A\u0D4D\u0D2A\u0D4B\u0D7E \u0D2A\u0D31\u0D2F\u0D41\u0D15. \u0D0E\u0D32\u0D4D\u0D32\u0D3E\u0D35\u0D7C\u0D15\u0D4D\u0D15\u0D41\u0D02 \u0D28\u0D28\u0D4D\u0D26\u0D3F, \u0D07\u0D28\u0D4D\u0D28\u0D24\u0D4D\u0D24\u0D47\u0D15\u0D4D\u0D15\u0D4D \u0D07\u0D24\u0D4D\u0D30\u0D2E\u0D3E\u0D24\u0D4D\u0D30\u0D02."
  };
  function speechPieces(pcm2) {
    const out = [];
    const tracker = new VoiceTracker((s) => out.push(s));
    for (let i = 0; i + 2048 <= pcm2.length; i += 2048) tracker.push(pcm2.subarray(i, i + 2048));
    tracker.flush();
    return out;
  }
  async function buildPrint(pcm2, embed) {
    const pieces = speechPieces(pcm2);
    const speechSec = pieces.reduce((a, p) => a + (p.t1 - p.t0), 0);
    if (speechSec < ENROL.minSpeechSec || pieces.length < ENROL.minPieces) {
      return { ok: false, speechSec, reason: `Only ${speechSec.toFixed(0)} seconds of clear speech were heard (about ${ENROL.minSpeechSec} are needed). Move closer to the microphone, cut background noise, and read the whole text.` };
    }
    const embs = [];
    for (const p of pieces) {
      const e = await embed(p.pcm.slice());
      if (e) embs.push(e);
    }
    if (embs.length < ENROL.minPieces) return { ok: false, speechSec, reason: "The voice model could not process enough of the recording. Try again." };
    let keep = embs;
    const first = mean(embs);
    const kept = embs.filter((e) => cosine(e, first) >= ENROL.minConsistency);
    if (kept.length >= ENROL.minPieces) keep = kept;
    const centroid = mean(keep);
    const spread = keep.map((e) => cosine(e, centroid));
    const consistency = spread.reduce((a, b) => a + b, 0) / spread.length;
    const step = Math.max(1, Math.floor(keep.length / ENROL.maxWindows));
    const windows = keep.filter((_2, i) => i % step === 0).slice(0, ENROL.maxWindows);
    return {
      ok: true,
      speechSec,
      pieces: keep.length,
      consistency,
      centroid: pack(centroid),
      windows: windows.map(pack),
      warn: consistency < 0.5 ? "The recording sounded uneven (background noise or more than one voice?). Re-record in a quiet place for better matching." : ""
    };
  }
  function newId() {
    return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  function upsertPerson(list, { id, name, lang: lang2, print }) {
    const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!clean) throw new Error("Give the person a name first.");
    const taken = list.find((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase());
    if (taken) throw new Error(`There is already a voice called ${taken.name}.`);
    const rec2 = { id: id || newId(), name: clean, lang: lang2 || "en", centroid: print.centroid, windows: print.windows, secs: Math.round(print.speechSec), created: Date.now() };
    const i = list.findIndex((p) => p.id === rec2.id);
    if (i < 0) return [...list, rec2];
    const next = [...list];
    next[i] = { ...next[i], ...rec2, created: next[i].created, updated: Date.now() };
    return next;
  }
  function addRecording(list, id, { lang: lang2, print }) {
    const i = list.findIndex((p2) => p2.id === id);
    if (i < 0) throw new Error("That person no longer exists.");
    const p = list[i];
    const c = mean([unpack(p.centroid), unpack(print.centroid)]);
    const windows = [...p.windows || [], ...print.windows].slice(-ENROL.maxWindows * 2);
    const langs = [.../* @__PURE__ */ new Set([...p.langs || [p.lang || "en"], lang2])];
    const next = [...list];
    next[i] = { ...p, centroid: pack(c), windows, langs, secs: (p.secs || 0) + Math.round(print.speechSec), updated: Date.now() };
    return next;
  }

  // src/voice/share.js
  var SHARE_FORMAT = "debrief-voices";
  var MODEL_ID = "wespeaker-resnet34-lm";
  var B64_256 = /^(?:[A-Za-z0-9+/]{4}){85}[A-Za-z0-9+/]{2}==$|^(?:[A-Za-z0-9+/]{4}){85}[A-Za-z0-9+/]{3}=$/;
  function exportVoices(list, ids) {
    const pick = ids ? list.filter((p) => ids.includes(p.id)) : list;
    return JSON.stringify(
      {
        format: SHARE_FORMAT,
        version: 1,
        model: MODEL_ID,
        exported: (/* @__PURE__ */ new Date()).toISOString(),
        people: pick.map((p) => ({ name: p.name, lang: p.lang || "en", langs: p.langs || [p.lang || "en"], secs: p.secs || 0, centroid: p.centroid, windows: p.windows || [] }))
      },
      null,
      1
    );
  }
  function parseImport(text) {
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return { people: [], problems: ["This is not a Debrief voices file (it could not be read)."] };
    }
    if (o?.format !== SHARE_FORMAT || !Array.isArray(o.people)) return { people: [], problems: ["This is not a Debrief voices file."] };
    if (o.model !== MODEL_ID) return { people: [], problems: [`These voices were made with a different speaker model (${String(o.model).slice(0, 40)}), so they cannot be matched here.`] };
    const people2 = [];
    const problems = [];
    for (const p of o.people.slice(0, 200)) {
      const name = String(p?.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (!name) {
        problems.push("A person without a name was skipped.");
        continue;
      }
      if (typeof p.centroid !== "string" || !B64_256.test(p.centroid)) {
        problems.push(`${name}: the fingerprint is damaged, skipped.`);
        continue;
      }
      const windows = Array.isArray(p.windows) ? p.windows.filter((w) => typeof w === "string" && B64_256.test(w)).slice(0, ENROL.maxWindows * 2) : [];
      const lang2 = String(p.lang || "en").slice(0, 8);
      const langs = Array.isArray(p.langs) ? p.langs.filter((l3) => typeof l3 === "string").map((l3) => l3.slice(0, 8)).slice(0, 6) : [];
      people2.push({ name, lang: lang2, langs: langs.length ? langs : [lang2], secs: Math.max(0, Math.min(3600, Number(p.secs) || 0)), centroid: p.centroid, windows });
    }
    return { people: people2, problems };
  }
  function mergeImport(list, incoming, { replace = false } = {}) {
    const next = [...list];
    const added = [];
    const replaced = [];
    const skipped = [];
    for (const p of incoming) {
      const i = next.findIndex((x2) => x2.name.toLowerCase() === p.name.toLowerCase());
      if (i >= 0 && !replace) {
        skipped.push(p.name);
        continue;
      }
      const rec2 = { ...p, id: i >= 0 ? next[i].id : newId(), created: i >= 0 ? next[i].created : Date.now(), updated: Date.now(), imported: true };
      if (i >= 0) {
        next[i] = rec2;
        replaced.push(p.name);
      } else {
        next.push(rec2);
        added.push(p.name);
      }
    }
    return { list: next, added, replaced, skipped };
  }

  // src/modal.js
  function modal({ title = "", text = "", input = null, select = null, buttons = [{ label: "OK", value: "ok", primary: true }] } = {}) {
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.className = "dbmodal";
      const h2 = document.createElement("div");
      h2.style.cssText = "white-space:pre-wrap;line-height:1.6;font-size:14.5px;color:var(--text)";
      h2.textContent = [title, text].filter(Boolean).join("\n\n");
      dlg.append(h2);
      let inp = null;
      let sel = null;
      if (input) {
        inp = Object.assign(document.createElement("input"), { value: input.value || "", placeholder: input.placeholder || "", maxLength: input.maxLength || 80 });
        inp.style.marginTop = "12px";
        dlg.append(inp);
      }
      if (select) {
        sel = document.createElement("select");
        sel.style.marginTop = "12px";
        for (const o of select) sel.append(Object.assign(document.createElement("option"), { value: o.value, textContent: o.label }));
        dlg.append(sel);
      }
      const row = document.createElement("div");
      row.className = "dbbtns";
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px";
      const done = (value) => {
        const out = value == null ? null : { value, input: inp?.value ?? "", select: sel?.value ?? "" };
        dlg.close();
        dlg.remove();
        resolve(out);
      };
      for (const b of buttons) {
        const el3 = Object.assign(document.createElement("button"), { className: `btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}`, textContent: b.label });
        el3.dataset.value = b.value;
        el3.onclick = () => done(b.value);
        row.append(el3);
      }
      dlg.append(row);
      dlg.addEventListener("cancel", (e) => {
        e.preventDefault();
        done(null);
      });
      if (inp) inp.addEventListener("keydown", (e) => e.key === "Enter" && done(buttons.find((b) => b.primary)?.value ?? buttons.at(-1).value));
      document.body.append(dlg);
      dlg.showModal();
      (inp || row.querySelector(".primary") || row.lastChild)?.focus();
    });
  }

  // src/dirtable.js
  var COLS = [
    { key: "name", label: "Name", ph: "Suresh K.", cls: "c-name" },
    { key: "title", label: "Title", ph: "Sri.", cls: "c-title" },
    { key: "dept", label: "Department", ph: "Transport", cls: "c-dept" },
    { key: "desig", label: "Designation", ph: "Joint Secretary", cls: "c-desig" },
    { key: "org", label: "Organisation", ph: "Metro", cls: "c-org" },
    { key: "email", label: "Email", ph: "suresh@metro.org", cls: "c-email" }
  ];
  function parseRows(text) {
    const rows = [];
    const notes = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) {
        notes.push(line);
        continue;
      }
      const p = line.split("|").map((x2) => x2.trim());
      rows.push({ name: p[0] || "", title: p[1] || "", dept: p[2] || "", desig: p[3] || "", org: p[4] || "", chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || ""), email: /@/.test(p[6] || "") ? p[6] : "" });
    }
    return { rows, notes };
  }
  function rowsToText(rows, notes = []) {
    const lines = rows.filter((r) => r.name.trim()).map((r) => {
      const cells = [r.name, r.title, r.dept, r.desig, r.org].map((x2) => String(x2 || "").trim().replace(/\|/g, "/")).join(" | ");
      const mail = String(r.email || "").trim().replace(/\|/g, "");
      return cells + (r.chair || mail ? ` | ${r.chair ? "Chair" : ""}` : "") + (mail ? ` | ${mail}` : "");
    });
    return [...notes, ...lines].join("\n");
  }
  function parsePasted(text) {
    return String(text || "").split(/\r?\n/).map((l3) => l3.trim()).filter(Boolean).map((l3) => {
      const p = l3.split(l3.includes("	") ? "	" : "|").map((x2) => x2.trim());
      return { name: p[0] || "", title: p[1] || "", dept: p[2] || "", desig: p[3] || "", org: p[4] || "", chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || ""), email: /@/.test(p[6] || "") ? p[6] : "" };
    });
  }
  var findRow = (rows, name) => rows.find((r) => r.name.trim().toLowerCase() === String(name || "").trim().toLowerCase()) || null;
  function upsertRow(rows, d) {
    const name = String(d.name || "").trim();
    if (!name) return rows;
    const row = findRow(rows, name);
    const fields = ["title", "dept", "desig", "org", "email"];
    if (!row) return [...rows, { name, title: "", dept: "", desig: "", org: "", chair: false, email: "", ...Object.fromEntries(fields.map((k2) => [k2, String(d[k2] || "").trim()])) }];
    for (const k2 of fields) if (String(d[k2] || "").trim()) row[k2] = String(d[k2]).trim();
    if (typeof d.chair === "boolean") row.chair = d.chair;
    return rows;
  }
  function mountDirectoryTable(textarea, host) {
    if (!textarea || !host) return;
    let rows = [];
    let notes = [];
    const emit = () => {
      textarea.value = rowsToText(rows, notes);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const make = (tag, props = {}, ...kids) => {
      const e = document.createElement(tag);
      for (const [k2, v] of Object.entries(props)) {
        if (k2 === "class") e.className = v;
        else if (k2.startsWith("on")) e[k2] = v;
        else if (v != null && v !== false) e.setAttribute(k2, v === true ? "" : v);
      }
      e.append(...kids.filter((x2) => x2 != null));
      return e;
    };
    function draw(focus) {
      host.replaceChildren();
      const head = make("div", { class: "dir-row dir-head", role: "row" }, ...COLS.map((c) => make("span", { class: `dir-h ${c.cls}`, role: "columnheader" }, c.label)), make("span", { class: "dir-h c-chair", role: "columnheader" }, "Chair"), make("span", { class: "c-x" }));
      const body = make("div", { class: "dir-body", role: "rowgroup" });
      rows.forEach((r, ri) => {
        const cells = COLS.map((c) => {
          const input = make("input", { class: `dir-in ${c.cls}`, type: "text", value: r[c.key], placeholder: ri === 0 ? c.ph : "", "aria-label": `${c.label}, person ${ri + 1}`, autocomplete: "off", maxlength: 80 });
          input.addEventListener("input", () => {
            r[c.key] = input.value;
            emit();
          });
          input.addEventListener("paste", (e) => {
            const text = e.clipboardData?.getData("text") || "";
            if (!/[\t\n]/.test(text.trim())) return;
            e.preventDefault();
            const got = parsePasted(text);
            rows.splice(ri, 1, ...got);
            emit();
            draw();
          });
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              rows.splice(ri + 1, 0, blank());
              emit();
              draw(`${ri + 1}.${c.key}`);
            }
          });
          input.dataset.key = `${ri}.${c.key}`;
          return input;
        });
        const chair = make("input", { class: "dir-chair c-chair", type: "checkbox", "aria-label": `${r.name || `Person ${ri + 1}`} is the usual chairperson` });
        chair.checked = !!r.chair;
        chair.addEventListener("change", () => {
          rows.forEach((x2, i) => x2.chair = i === ri ? chair.checked : x2.chair);
          r.chair = chair.checked;
          emit();
        });
        const del = make("button", { class: "dir-x c-x", type: "button", title: "Remove this person", "aria-label": `Remove ${r.name || `person ${ri + 1}`}` }, "\xD7");
        del.addEventListener("click", () => {
          rows.splice(ri, 1);
          emit();
          draw();
        });
        body.append(make("div", { class: "dir-row", role: "row" }, ...cells, chair, del));
      });
      const add = make("button", { class: "btn sm dir-add", type: "button" }, "+ Add a person");
      add.addEventListener("click", () => {
        rows.push(blank());
        draw(`${rows.length - 1}.name`);
      });
      host.append(make("div", { class: "dir-table", role: "table", "aria-label": "People directory" }, head, body), make("div", { class: "dir-foot" }, add, make("span", { class: "hint" }, "Tip: paste rows from a spreadsheet (Name, Title, Department, Designation, Organisation, Email) into any name cell.")));
      if (focus) host.querySelector(`[data-key="${focus}"]`)?.focus();
    }
    const blank = () => ({ name: "", title: "", dept: "", desig: "", org: "", chair: false, email: "" });
    const load = () => {
      const parsed = parseRows(textarea.value);
      rows = parsed.rows;
      notes = parsed.notes;
      if (!rows.length) rows = [blank()];
      draw();
    };
    textarea.hidden = true;
    textarea.addEventListener("dir-refresh", load);
    textarea.addEventListener("dir-upsert", (e) => {
      rows = rows.filter((r) => r.name.trim() || r.title || r.dept || r.desig || r.org || r.email);
      rows = upsertRow(rows, e.detail || {});
      if (!rows.length) rows = [blank()];
      emit();
      draw();
    });
    textarea.addEventListener("dir-rename", (e) => {
      const { from, to } = e.detail || {};
      const row = findRow(rows, from);
      if (row && to && !findRow(rows, to)) {
        row.name = String(to).trim();
        emit();
        draw();
      }
    });
    textarea.addEventListener("dir-focus", (e) => {
      const name = e.detail?.name;
      if (!name) return;
      rows = rows.filter((r) => r.name.trim() || r.title || r.dept || r.desig || r.org || r.email);
      if (!findRow(rows, name)) rows = upsertRow(rows, { name });
      emit();
      draw();
      const i = rows.findIndex((r) => r.name.trim().toLowerCase() === String(name).trim().toLowerCase());
      const first = ["desig", "org", "dept", "title", "email"].find((k2) => !rows[i][k2]) || "desig";
      const input = host.querySelector(`[data-key="${i}.${first}"]`);
      input?.scrollIntoView({ block: "center", behavior: "smooth" });
      input?.focus();
    });
    load();
  }

  // src/voices-ui.js
  var OKBTN = [{ label: "OK", value: "ok", primary: true }];
  var tell = (text) => modal({ text, buttons: OKBTN });
  var $2 = (id) => document.getElementById(id);
  var MAX_SEC2 = 40;
  var people = [];
  var mode = { kind: "new", id: null };
  var lang = "en";
  var pcm = null;
  var audioUrl = "";
  var rec = null;
  var client = null;
  var el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };
  var setMsg = (t, kind = "") => {
    $2("enrolMsg").textContent = t;
    $2("enrolMsg").className = `msgbox ${kind === true ? "bad" : kind || ""}`.trim();
  };
  var READY_MSG = "Type a name, then press Record and read the text above. Use the mic you use in meetings.";
  var clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  var saving = false;
  function syncEnrol() {
    $2("enrolRec").hidden = !!rec;
    $2("enrolStop").hidden = !rec;
    $2("enrolDot").hidden = !rec;
    $2("enrolPlay").disabled = !pcm;
    $2("enrolSave").disabled = !pcm || saving;
  }
  function getClient() {
    if (!client) {
      client = createVoiceClient({
        workerUrl: chrome.runtime.getURL("dist/worker.js"),
        modelUrl: chrome.runtime.getURL("models/wespeaker_resnet34_lm.onnx"),
        wasmPaths: chrome.runtime.getURL("vendor/ort/"),
        maxQueue: 64
      });
    }
    return client;
  }
  function closeClient() {
    client?.close();
    client = null;
  }
  var LANG_NAME = { en: "English", hi: "Hindi", ml: "Malayalam", free: "free speech" };
  var ORDER = ["en", "hi", "ml", "free"];
  var fmtDate = (t) => new Date(t).toLocaleDateString(void 0, { day: "numeric", month: "short", year: "numeric" });
  function badgeOf(p) {
    if (!p.auto) return ["Recorded", "brand"];
    if (isAnon(p)) return ["Unnamed voice", ""];
    if (p.confirmed) return ["Named by you, in use", "ok"];
    return p.ready ? ["Learned, in use", "ok"] : ["Learned, still learning", "warn"];
  }
  var openMenu = null;
  function closeMenu(refocus) {
    if (!openMenu) return;
    const { menu, more } = openMenu;
    openMenu = null;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
    if (refocus) more.focus();
  }
  function moreMenu(p, items) {
    const more = el("button", { type: "button", className: "btn sm", textContent: "More \u25BE" });
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-label", `More actions for ${p.name}`);
    const menu = el("div", { className: "menu", hidden: true });
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `More actions for ${p.name}`);
    const btns = items.map(({ label, fn: fn2, danger, aria }) => {
      const b = el("button", { type: "button", className: danger ? "danger" : "", textContent: label });
      b.setAttribute("role", "menuitem");
      if (aria) b.setAttribute("aria-label", aria);
      b.onclick = () => {
        closeMenu(true);
        fn2();
      };
      return b;
    });
    menu.append(...btns);
    menu.addEventListener("keydown", (e) => {
      const i = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") btns[(i + 1) % btns.length].focus();
      else if (e.key === "ArrowUp") btns[(i - 1 + btns.length) % btns.length].focus();
      else if (e.key === "Escape") closeMenu(true);
      else if (e.key === "Tab") closeMenu(false);
      else return;
      if (e.key !== "Tab") e.preventDefault();
    });
    more.onclick = () => {
      const wasOpen = openMenu?.menu === menu;
      closeMenu(false);
      if (wasOpen) return;
      menu.hidden = false;
      more.setAttribute("aria-expanded", "true");
      openMenu = { menu, more };
      btns[0].focus();
    };
    return [more, menu];
  }
  function renderList() {
    closeMenu(false);
    stopPlaying();
    $2("voiceEmpty").hidden = people.length > 0;
    $2("hPeople").textContent = people.length ? `Enrolled people \xB7 ${people.length}` : "Enrolled people";
    $2("voiceList").replaceChildren(
      ...people.map((p) => {
        const anon = p.auto && isAnon(p);
        const [badge, cls] = badgeOf(p);
        const langs = (p.langs || [p.lang || "en"]).map((l3) => LANG_NAME[l3] || l3).join(" + ");
        const n = p.meetings || 1;
        const meta = p.auto ? `${anon ? "Heard in your meetings, not named yet" : "Learned from your meetings"} \xB7 ${n} meeting${n === 1 ? "" : "s"} \xB7 ${p.secs || 0} s of clean speech${p.ready || p.confirmed ? "" : ` \xB7 not used yet, needs ${LEARN.readySecs} s from ${LEARN.readyMeetings} meetings, or give it a name`}${anon && !samplesOn ? " \xB7 no audio clip (switch on \u201CKeep a short sample\u201D before the next meeting). Meanwhile open that meeting\u2019s Transcript: this voice\u2019s lines are labelled with this name, so you can name it by reading what it said." : ""}` : `${langs} \xB7 ${p.secs || "?"} s of speech \xB7 added ${fmtDate(p.created)}`;
        const prof = anon ? null : profileOf(p.name);
        const row = el("li", { className: "voice-row" });
        const initial = anon ? "?" : (Array.from(p.name.trim())[0] || "?").toUpperCase();
        const avatar = el("span", { className: `avatar${anon ? " anon" : ""}`, textContent: initial });
        avatar.setAttribute("aria-hidden", "true");
        const who = el("div", { className: "vwho" }, el("div", { className: "vtop" }, el("strong", { className: "vn", textContent: p.name }), el("span", { className: `chip ${cls}`.trim(), textContent: badge })), el("p", { className: "hint vm", textContent: meta }));
        const btn = (label, fn2) => el("button", { type: "button", className: "btn sm", textContent: label, onclick: fn2 });
        const items = [{ label: "Export this voice", fn: () => download(exportVoices(people, [p.id]), `debrief-voice-${p.name.replace(/[^\w-]+/g, "_")}.json`) }];
        if (p.auto && people.length > 1) items.push({ label: "Merge into\u2026", fn: () => mergeInto(p) });
        items.push({ label: "Delete", aria: `Delete ${p.name}`, fn: () => remove(p), danger: true });
        const acts = el("div", { className: "vacts" }, sampleButton(p), btn(anon ? "Name this voice" : "Rename", () => rename(p)), ...anon ? [] : [btn(prof && profileLine(prof) ? "Edit details" : "Add details", () => focusDetails(p.name))], ...anon ? [] : [btn("Re-record", () => begin({ kind: "rerecord", id: p.id }, p)), btn("Add recording", () => begin({ kind: "add", id: p.id }, p))], ...moreMenu(p, items));
        if (prof && profileLine(prof)) who.append(el("p", { className: "vprofile", textContent: profileLine(prof) }));
        row.append(avatar, who, acts);
        return row;
      })
    );
  }
  var playing = null;
  var playingUrl = "";
  function stopPlaying() {
    playing?.pause();
    playing = null;
    if (playingUrl) URL.revokeObjectURL(playingUrl);
    playingUrl = "";
  }
  function sampleButton(p) {
    const b = el("button", { type: "button", className: "btn sm", hidden: true }, el("span", { className: "tri" }), "Play sample");
    b.setAttribute("aria-label", `Play sample of ${p.name}`);
    hasSample(p.id).then((yes) => b.hidden = !yes).catch(() => {
    });
    b.onclick = async () => {
      if (b.dataset.busy) return;
      b.dataset.busy = "1";
      try {
        stopPlaying();
        const blob = await getSample(p.id);
        if (!blob) return b.hidden = true;
        playingUrl = URL.createObjectURL(blob);
        playing = new Audio(playingUrl);
        playing.onended = stopPlaying;
        await playing.play();
      } catch {
        stopPlaying();
        b.hidden = true;
        deleteSample(p.id).catch(() => {
        });
      } finally {
        delete b.dataset.busy;
      }
    };
    return b;
  }
  var dirRows = [];
  var profileOf = (name) => findRow(dirRows, name);
  var profileLine = (r) => [r?.desig, r?.dept, r?.org, r?.email].filter(Boolean).join(" \xB7 ");
  async function saveDirectory(detail, eventName = "dir-upsert") {
    const ta = $2("peopleDirectory");
    if (!ta) return;
    ta.dispatchEvent(new CustomEvent(eventName, { detail }));
    try {
      await setSetting({ peopleDirectory: ta.value });
    } catch {
    }
    dirRows = parseRows(ta.value).rows;
    renderList();
  }
  function focusDetails(name) {
    $2("peopleCard")?.scrollIntoView({ block: "start", behavior: "smooth" });
    $2("peopleDirectory")?.dispatchEvent(new CustomEvent("dir-focus", { detail: { name } }));
  }
  function detailInputs(idPrefix) {
    const mk = (k2, label, ph) => el("label", { className: "dt-f" }, el("span", { textContent: label }), el("input", { id: `${idPrefix}-${k2}`, placeholder: ph, autocomplete: "off", type: k2 === "email" ? "email" : "text", maxLength: 80 }));
    const box = el(
      "details",
      { className: "more-details" },
      el("summary", { textContent: "Their details for the minutes (optional)" }),
      el("div", { className: "detail-row" }, mk("title", "Title", "Sri."), mk("desig", "Designation", "Joint Secretary"), mk("dept", "Department", "Transport"), mk("org", "Organisation", "Kochi Metro"), mk("email", "Email", "name@company.com"))
    );
    const read2 = () => Object.fromEntries(["title", "desig", "dept", "org", "email"].map((k2) => [k2, box.querySelector(`#${idPrefix}-${k2}`).value.trim()]));
    return { box, read: read2 };
  }
  var samplesOn = false;
  async function refresh() {
    const st2 = await getSettings();
    dirRows = parseRows(st2.peopleDirectory).rows;
    samplesOn = !!st2.voiceSamples;
    people = await getVoices();
    renderList();
    renderUnnamed().catch(() => {
    });
  }
  async function renderUnnamed() {
    const meetings = (await listMeetings()).filter((m2) => (m2.voiceSegs || []).length >= 20).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const m = meetings[0];
    const groups = m ? unnamedGroups(m, people) : [];
    $2("unnamedCard").hidden = !groups.length;
    if (m) $2("unnamedSub").textContent = `${m.title || "Your latest meeting"}${m.startedAt ? ` \xB7 ${fmtDate(m.startedAt)}` : ""}. Name a voice once and it is recognised next time.`;
    $2("unnamedList").replaceChildren(
      ...groups.map((g, i) => {
        const label = el("label", { className: "sr-only", htmlFor: `unnamedName${i}`, textContent: `Name for Voice ${i + 1}` });
        const input = el("input", { id: `unnamedName${i}`, placeholder: "Who is this?", maxLength: 60, autocomplete: "off" });
        const save3 = el("button", { type: "button", className: "btn primary", textContent: "Name this voice" });
        const det = detailInputs(`un${i}`);
        const doSave = async () => {
          try {
            const typed = input.value.trim().replace(/\s+/g, " ");
            const same2 = people.find((x2) => x2.name.toLowerCase() === typed.toLowerCase());
            if (same2) {
              const ask = await modal({ text: `${same2.name} already has a voice. Is this the same person? Their voices will be joined.`, buttons: [{ label: "No, keep it separate", value: "no" }, { label: `Add to ${same2.name}`, value: "merge", primary: true }] });
              if (ask?.value !== "merge") return;
              people = addRecording(people, same2.id, { lang: "free", print: { centroid: g.centroid, windows: g.windows, speechSec: g.seconds } });
              await saveVoices(people);
              getSample(key2).then((b) => b && !same2.hasClip && hasSample(same2.id).then((has) => !has && putSample(same2.id, b))).catch(() => {
              });
              renderList();
              renderUnnamed();
              return;
            }
            people = upsertPerson(people, { name: input.value, lang: "free", print: { centroid: g.centroid, windows: g.windows, speechSec: g.seconds } });
            await saveVoices(people);
            await saveDirectory({ name: input.value, ...det.read() });
            const named = people.find((x2) => x2.name.toLowerCase() === input.value.trim().replace(/\s+/g, " ").toLowerCase());
            getSample(key2).then((b) => b && named && putSample(named.id, b)).catch(() => {
            });
            renderList();
            renderUnnamed();
          } catch (e) {
            tell(e.message);
          }
        };
        save3.onclick = doSave;
        input.onkeydown = (e) => e.key === "Enter" && doSave();
        const key2 = unnamedKey(m.id, g.at[0]);
        const play = el("button", { type: "button", className: "btn sm", hidden: true }, el("span", { className: "tri" }), "Play");
        play.setAttribute("aria-label", `Play a clip of Voice ${i + 1}`);
        hasSample(key2).then((yes) => play.hidden = !yes).catch(() => {
        });
        play.onclick = async () => {
          try {
            stopPlaying();
            const blob = await getSample(key2);
            if (!blob) return play.hidden = true;
            playingUrl = URL.createObjectURL(blob);
            playing = new Audio(playingUrl);
            playing.onended = stopPlaying;
            await playing.play();
          } catch {
            stopPlaying();
          }
        };
        return el(
          "li",
          {},
          el("div", { className: "ut" }, el("strong", { textContent: `Voice ${i + 1}` }), el("span", { className: "hint", textContent: `spoke ${g.seconds} s` })),
          el("p", { className: "hint", textContent: `For example at ${g.at.map(fmtTime).join(", ")}` }),
          el("div", { className: "name-row" }, play, label, input, save3),
          det.box
        );
      })
    );
  }
  async function rename(p) {
    const r = await modal({ text: `New name for ${p.name}`, input: { value: isAnon(p) ? "" : p.name, placeholder: "Their name", maxLength: 60 }, buttons: [{ label: "Cancel", value: "no" }, { label: "Rename", value: "ok", primary: true }] });
    if (!r || r.value !== "ok") return;
    try {
      const clean = r.input.trim().replace(/\s+/g, " ").slice(0, 60);
      if (!clean) throw new Error("A name cannot be empty.");
      const taken = people.find((x2) => x2.id !== p.id && x2.name.toLowerCase() === clean.toLowerCase());
      if (taken) {
        const ask = await modal({ text: `${taken.name} already has a voice. Is this the same person? Merging joins the two, and the result is called ${taken.name}.`, buttons: [{ label: "No, keep both", value: "no" }, { label: `Merge into ${taken.name}`, value: "merge", primary: true }] });
        if (ask?.value === "merge") await mergeVoices(p, taken.id);
        return;
      }
      people = people.map((x2) => x2.id === p.id ? { ...x2, name: clean, ...x2.auto ? { confirmed: true } : {} } : x2);
      await saveVoices(people);
      if (!isAnon(p)) await saveDirectory({ from: p.name, to: clean }, "dir-rename");
      await saveDirectory({ name: clean });
      renderList();
      const st2 = await getSettings();
      if (!st2.voiceOn) {
        const on = await modal({ text: `${clean} is saved. Naming speakers by voice is switched off, so transcripts and minutes will not use the name yet. Turn it on?`, buttons: [{ label: "Not now", value: "no" }, { label: "Turn on", value: "yes", primary: true }] });
        if (on?.value === "yes") await setSetting({ voiceOn: true });
      }
    } catch (e) {
      tell(e.message);
    }
  }
  async function remove(p) {
    const buttons = [{ label: "Cancel", value: "no" }, { label: "Delete", value: "del", danger: true }];
    if (p.auto) buttons.push({ label: "Delete and never learn it again", value: "block", danger: true });
    const r = await modal({ text: `Delete the voice of ${p.name}? Their fingerprint is removed from this browser.${p.auto ? '\n\nThis voice was learned from your meetings, so Debrief may learn it again after another meeting unless you choose "never learn it again".' : ""}`, buttons });
    if (!r || r.value === "no") return;
    try {
      if (r.value === "block") {
        await saveBlockedVoices([...await getBlockedVoices(), blockEntry(p)]);
        renderBlocked();
      }
      people = people.filter((x2) => x2.id !== p.id);
      await saveVoices(people);
      deleteSample(p.id).catch(() => {
      });
      renderList();
    } catch (e) {
      tell(`Could not delete: ${e.message}`);
    }
  }
  async function mergeVoices(p, intoId) {
    try {
      people = mergePeople(people, p.id, intoId);
      await saveVoices(people);
      const mine = await getSample(p.id).catch(() => null);
      if (mine && !await hasSample(intoId).catch(() => true)) await putSample(intoId, mine).catch(() => {
      });
      deleteSample(p.id).catch(() => {
      });
      renderList();
      renderUnnamed().catch(() => {
      });
    } catch (e) {
      tell(e.message);
    }
  }
  async function mergeInto(p) {
    const others = people.filter((x2) => x2.id !== p.id);
    const r = await modal({ text: `Merge ${p.name} into which voice? The result keeps that voice's name.`, select: others.map((x2) => ({ value: x2.id, label: x2.name })), buttons: [{ label: "Cancel", value: "no" }, { label: "Merge", value: "ok", primary: true }] });
    if (!r || r.value !== "ok") return;
    try {
      people = mergePeople(people, p.id, r.select);
      await saveVoices(people);
      const mine = await getSample(p.id).catch(() => null);
      if (mine && !await hasSample(r.select).catch(() => true)) await putSample(r.select, mine).catch(() => {
      });
      deleteSample(p.id).catch(() => {
      });
      renderList();
    } catch (e) {
      tell(e.message);
    }
  }
  async function renderBlocked() {
    const blocked = await getBlockedVoices();
    $2("voiceBlockedRow").hidden = !blocked.length;
    $2("voiceBlockedMsg").textContent = `${blocked.length} learned voice${blocked.length === 1 ? " is" : "s are"} set never to be learned again.`;
  }
  function resetRecording() {
    stopCapture(true);
    pcm = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = "";
    $2("enrolRec").textContent = "Record";
    $2("enrolLevel").style.width = "0";
    $2("enrolTime").textContent = "";
    syncEnrol();
  }
  function blankForm() {
    mode = { kind: "new", id: null };
    resetRecording();
    $2("enrolName").value = "";
    for (const id of ["enrolTitleW", "enrolDesig", "enrolDept", "enrolOrg", "enrolEmail"]) if ($2(id)) $2(id).value = "";
    $2("enrolName").disabled = false;
    $2("enrolTitle").textContent = "Add a person";
  }
  function begin(m, person) {
    resetRecording();
    mode = m;
    $2("enrolTitle").textContent = m.kind === "new" ? "Add a person" : m.kind === "rerecord" ? `Re-record ${person.name}` : `Add another recording for ${person.name}`;
    $2("enrolName").value = person ? person.name : "";
    $2("enrolName").disabled = !!person;
    setLang(m.kind === "add" ? ORDER.find((l3) => !(person.langs || [person.lang || "en"]).includes(l3)) || "free" : lang);
    setMsg(m.kind === "add" ? "Record in another language this person uses in meetings: it makes the voice recognisable in each." : READY_MSG, m.kind === "add" ? "info" : "");
    (person ? $2("enrolRec") : $2("enrolName")).scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
    (person ? $2("enrolRec") : $2("enrolName")).focus({ preventScroll: true });
  }
  var reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function setLang(l3) {
    lang = l3;
    $2("enrolPrompt").textContent = PROMPTS[l3];
    $2("enrolPrompt").lang = l3 === "free" ? "en" : l3;
    document.querySelectorAll("#enrolLang button").forEach((b) => {
      const on = b.dataset.lang === l3;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  async function startCapture() {
    if (rec) return;
    setMsg("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const ctx = new AudioContext({ sampleRate: SR2 });
    await ctx.audioWorklet.addModule("worklet.js");
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-tap", { channelCount: 1, channelCountMode: "explicit" });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    const r = { ctx, stream, node, blocks: [], started: Date.now(), timer: 0, peak: 0 };
    node.port.onmessage = (e) => {
      const b = e.data;
      r.blocks.push(b);
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i] * b[i];
      const rms = Math.sqrt(s / b.length);
      r.peak = Math.max(r.peak, rms);
      const db = 20 * Math.log10(rms + 1e-9);
      $2("enrolLevel").style.width = `${Math.max(0, Math.min(100, (db + 50) / 40 * 100))}%`;
    };
    r.timer = setInterval(() => {
      const sec = (Date.now() - r.started) / 1e3;
      $2("enrolTime").textContent = `${clock(sec)}${sec < ENROL.targetSec ? "" : " \u2713"}`;
      if (sec >= MAX_SEC2) finishCapture();
    }, 250);
    rec = r;
    syncEnrol();
  }
  function stopCapture(discard) {
    if (!rec) return null;
    const r = rec;
    rec = null;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close().catch(() => {
    });
    if (discard) return null;
    const len = r.blocks.reduce((a, b) => a + b.length, 0);
    const out = new Float32Array(len);
    let o = 0;
    for (const b of r.blocks) {
      out.set(b, o);
      o += b.length;
    }
    return { pcm: out, peak: r.peak };
  }
  function finishCapture() {
    const got = stopCapture(false);
    $2("enrolRec").textContent = "Record again";
    $2("enrolLevel").style.width = "0";
    syncEnrol();
    if (!got || got.pcm.length < SR2 * 3) {
      setMsg("That was too short. Press Record and read the text above.", "warn");
      return;
    }
    if (got.peak < 5e-3) {
      setMsg("Almost nothing was picked up. Check that the right microphone is selected in Chrome, then record again.", "bad");
      return;
    }
    pcm = got.pcm;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(new Blob([encodeWav(pcm, SR2)], { type: "audio/wav" }));
    $2("enrolTime").textContent = clock(pcm.length / SR2);
    syncEnrol();
    setMsg("Play it back to check it is clear, then save. Nothing is stored until you press Save voice.", "ok");
  }
  async function save() {
    if (!pcm) return;
    const name = $2("enrolName").value;
    try {
      if (mode.kind === "new") upsertPerson(people, { name, lang, print: { centroid: "", windows: [], speechSec: 0 } });
      saving = true;
      syncEnrol();
      setMsg("Working out the voice fingerprint\u2026 (the first time this loads the speaker model)", "info");
      const c = getClient();
      await Promise.race([c.ready, new Promise((_2, rej) => setTimeout(() => rej(new Error("The speaker model did not load. Reload this page and try again.")), 6e4))]);
      const print = await buildPrint(pcm, (p) => c.embed(p));
      if (!print.ok) {
        setMsg(print.reason, "warn");
        return;
      }
      const keep = !!(await getSettings()).voiceSamples;
      let newId2 = mode.id;
      if (mode.kind === "new") {
        people = upsertPerson(people, { name, lang, print });
        newId2 = people[people.length - 1].id;
      } else if (mode.kind === "rerecord") people = upsertPerson(people, { id: mode.id, name, lang, print });
      else people = addRecording(people, mode.id, { lang, print });
      await saveVoices(people);
      let clipOk = false;
      if (keep && newId2 && (mode.kind !== "add" || !await hasSample(newId2))) {
        const best = speechPieces(pcm).sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0)).map((x2) => x2.pcm);
        clipOk = await putSample(newId2, makeClip(best.length ? best : [pcm])).then(() => true, () => false);
      }
      await saveDirectory({ name, title: $2("enrolTitleW").value, desig: $2("enrolDesig").value, dept: $2("enrolDept").value, org: $2("enrolOrg").value, email: $2("enrolEmail").value });
      const done = `Saved ${name.trim()}: ${print.pieces} pieces of speech, ${print.speechSec.toFixed(0)} s. ${clipOk ? "The fingerprint and a short audio clip you can play were stored." : "Only the fingerprint was stored."}${print.warn ? ` ${print.warn}` : ""}`;
      blankForm();
      setMsg(done, "ok");
      renderList();
    } catch (e) {
      setMsg(e.message, "bad");
    } finally {
      saving = false;
      syncEnrol();
    }
  }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
  }
  async function importFile(file) {
    const out = $2("voiceShareMsg");
    try {
      if (file.size > 2e6) throw new Error("That file is too large to be a voices file.");
      const { people: incoming, problems } = parseImport(await file.text());
      if (!incoming.length) {
        out.textContent = problems[0] || "Nothing to import.";
        return;
      }
      const clash = incoming.filter((p) => people.some((x2) => x2.name.toLowerCase() === p.name.toLowerCase())).map((p) => p.name);
      const ans = clash.length ? await modal({ text: `${clash.join(", ")} ${clash.length === 1 ? "is" : "are"} already enrolled here. Replace with the imported voice?`, buttons: [{ label: "Keep mine", value: "keep" }, { label: "Replace", value: "replace", primary: true }] }) : null;
      const replace = ans?.value === "replace";
      const r = mergeImport(people, incoming, { replace });
      people = r.list;
      await saveVoices(people);
      renderList();
      out.textContent = `Imported ${r.added.length} new${r.replaced.length ? `, replaced ${r.replaced.length}` : ""}${r.skipped.length ? `, kept your existing ${r.skipped.join(", ")}` : ""}.${problems.length ? ` ${problems.join(" ")}` : ""} Imported voices are only as good as the original recording: check them on a real meeting.`;
    } catch (e) {
      out.textContent = e.message;
    }
  }
  async function initVoices() {
    await refresh();
    setLang("en");
    const langBtns = [...document.querySelectorAll("#enrolLang button")];
    langBtns.forEach((b, i) => {
      b.onclick = () => setLang(b.dataset.lang);
      b.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = langBtns[(i + d + langBtns.length) % langBtns.length];
        setLang(next.dataset.lang);
        next.focus();
      });
    });
    document.addEventListener("click", (e) => {
      if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.more.contains(e.target)) closeMenu(false);
    });
    $2("enrolJump").onclick = () => {
      $2("enrol").scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
      $2("enrolName").focus({ preventScroll: true });
    };
    setMsg(READY_MSG);
    syncEnrol();
    $2("enrolRec").onclick = async () => {
      try {
        if (pcm) pcm = null;
        syncEnrol();
        if (mode.kind === "new" && !$2("enrolName").value.trim()) {
          setMsg("Type the person\u2019s name first.", "bad");
          $2("enrolName").focus();
          return;
        }
        await startCapture();
        $2("enrolStop").focus();
        setMsg("Listening\u2026 keep going until about 20 seconds.", "info");
      } catch (e) {
        setMsg(e.name === "NotAllowedError" ? "The microphone is blocked. Use \u201CAllow microphone\u201D on the General page, then try again." : e.name === "NotFoundError" ? "No microphone is available. Allow it in General, under Microphone, or plug one in." : `Could not start the microphone: ${e.message}`, "bad");
      }
    };
    $2("enrolStop").onclick = () => {
      finishCapture();
      $2("enrolPlay").disabled ? $2("enrolRec").focus() : $2("enrolPlay").focus();
    };
    $2("enrolPlay").onclick = () => audioUrl && new Audio(audioUrl).play();
    $2("enrolSave").onclick = save;
    $2("enrolCancel").onclick = () => {
      blankForm();
      setMsg(READY_MSG);
    };
    $2("voiceExport").onclick = () => people.length ? download(exportVoices(people), "debrief-voices.json") : $2("voiceShareMsg").textContent = "Nobody is enrolled yet.";
    $2("voiceImport").onclick = () => $2("voiceImportFile").click();
    $2("voiceImportFile").onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) importFile(f);
    };
    renderBlocked();
    $2("voiceAllowAgain").onclick = async () => {
      await saveBlockedVoices([]);
      renderBlocked();
    };
    $2("voiceForget").onclick = async () => {
      const ok = await modal({ text: "Forget all voices? This deletes every enrolled fingerprint and the voice fingerprints saved with past meetings. It cannot be undone.", buttons: [{ label: "Cancel", value: "no" }, { label: "Forget all voices", value: "yes", danger: true }] });
      if (ok?.value !== "yes") return;
      const n = await forgetAllVoices();
      people = [];
      renderList();
      closeClient();
      setMsg(`All voices forgotten${n ? ` (and fingerprints removed from ${n} saved meeting${n === 1 ? "" : "s"})` : ""}.`, "ok");
    };
    chrome.storage.onChanged.addListener((c) => {
      if (c.voices) refresh();
    });
    window.addEventListener("pagehide", () => {
      stopCapture(true);
      closeClient();
    });
  }

  // src/checkup.js
  var backupCount = (s) => (s.geminiKey2 ? 1 : 0) + (s.geminiBackups || []).filter(Boolean).length;
  var OK = "\u2713";
  var WARN = "!";
  var BAD = "\u2717";
  async function runCheckup() {
    const rows = [];
    const add = (level, title, detail = "", go = "", fixText = "") => rows.push({ level, title, detail, go, fixText });
    const s = await getSettings();
    if (s.sttProvider === "gemini" || s.llmProvider === "gemini") {
      add(s.geminiKey ? OK : BAD, "Gemini key", s.geminiKey ? backupCount(s) ? `main key and ${backupCount(s)} backup key${backupCount(s) === 1 ? "" : "s"} are set` : "a key is set (no backup key)" : "missing: add it on the Get started page", "start", "Add key");
      try {
        const { usage, learnedLimits = {}, modelCooldown = {} } = await chrome.storage.local.get(["usage", "learnedLimits", "modelCooldown"]);
        const limits = { ...learnedLimits, ...parseLimits(s.usageLimits) };
        const today = summarize(usage, 1);
        const used = (m) => today.filter((x2) => x2.model === m).reduce((a, x2) => a + x2.req, 0);
        for (const m of [s.sttGeminiModel, s.geminiModel].filter(Boolean)) {
          const lim = limits[m];
          if (!lim) add(OK, `Quota today: ${m}`, `${used(m)} request${used(m) === 1 ? "" : "s"} so far (limit not known yet)`);
          else add(used(m) >= lim ? BAD : used(m) >= lim * 0.8 ? WARN : OK, `Quota today: ${m}`, `${used(m)} of about ${lim} requests used`);
        }
        const cooling = Object.entries(modelCooldown).filter(([, u]) => u > Date.now());
        if (cooling.length) add(WARN, "Models resting after hitting their limit", cooling.map(([m, u]) => `${m} until ${new Date(u).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`).join(", "));
      } catch {
      }
    }
    try {
      const p = await navigator.permissions.query({ name: "microphone" });
      add(p.state === "granted" ? OK : s.captureMic === false ? OK : WARN, "Microphone permission", p.state === "granted" ? "allowed" : `${p.state}: only other people will be recorded until you press "Allow microphone" on the General page`, "general", "Allow microphone");
    } catch {
    }
    add(s.followMeetMute !== false ? OK : WARN, "Mic follows the call's mute button", s.followMeetMute !== false ? "on" : "off: your mic is recorded even when you are muted in the call", "general", "Turn it on");
    add(OK, "Speaker names from Meet captions", { read: "used when captions are on", auto: "Debrief turns captions on while recording", off: "off" }[s.meetCaptions] || s.meetCaptions);
    if (!s.emailWebhook) add(WARN, "Email relay", "not set up (optional)", "email", "Set up email");
    else if (!mailReady(s)) add(BAD, "Email relay", "the URL does not look like an Apps Script web app URL ending in /exec", "email", "Fix email");
    else {
      try {
        const res = await fetch(s.emailWebhook, { redirect: "follow", signal: AbortSignal.timeout(15e3) });
        const j2 = await res.json();
        if (j2?.ok) add(Number(j2.version) >= 8 ? OK : WARN, "Email relay", `reachable, script version ${j2.version}${Number(j2.version) >= 8 ? "" : ". Version 8 closes a first-use window: copy the script again from Settings > Email and deploy a new version"}`);
        else add(BAD, "Email relay", 'answered, but not as the Debrief script (is it set to "Anyone"?)', "email", "Fix email");
      } catch (e) {
        add(BAD, "Email relay", `could not be reached (${e.message}). Check the deployment is set to "Anyone"`, "email", "Fix email");
      }
    }
    const voices = await getVoices();
    const blocked = await getBlockedVoices();
    add(OK, "Voice recognition", `${s.voiceOn ? "naming is on" : "naming is off"}, ${s.voiceLearn ? "learning is on" : "learning is off"}; ${voices.filter((v) => !v.auto).length} recorded, ${voices.filter((v) => v.auto && v.ready).length} learned and in use, ${voices.filter((v) => v.auto && !v.ready).length} still learning${blocked.length ? `, ${blocked.length} blocked` : ""}`);
    try {
      const r = await fetch(chrome.runtime.getURL("models/wespeaker_resnet34_lm.onnx"), { method: "HEAD" });
      add(r.ok ? OK : BAD, "Speaker model file", r.ok ? "present in the extension" : "missing from the extension folder");
    } catch {
      add(BAD, "Speaker model file", "could not be read");
    }
    try {
      const m = (await listMeetings()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
      if (m) {
        const dbg = m.debug || [];
        const muteLines = dbg.filter((x2) => /^Meet mic/.test(x2));
        const silent = dbg.find((x2) => /^mic: the raw microphone/.test(x2));
        add(OK, `Last meeting: ${m.title || m.id}`, `${(m.segments || []).length} transcript pieces, ${(m.errors || []).length} errors, ${Object.keys(m.presence || {}).length} people seen, ${(m.voiceSegs || []).length} voice pieces, ${(m.captions || []).length} caption lines`);
        add(muteLines.length ? OK : WARN, "Last meeting: the call's mute button", muteLines.length ? `${muteLines.length} changes seen; last: ${muteLines.at(-1)}` : "no mute changes were seen (either you never muted, or the mute button was not found on the page)");
        if (silent) add(BAD, "Last meeting: microphone", "it delivered only silence: check the microphone chosen in General and Windows privacy settings", "general", "Open General");
        add(m.invited?.length ? OK : WARN, "Last meeting: calendar invite", m.invited?.length ? `${m.invited.length} invitees found${m.invitedHow ? ` (by ${m.invitedHow})` : ""}` : m.invitedError ? `lookup failed: ${String(m.invitedError).slice(0, 100)}` : m.invitedNotFound ? "no calendar event matched the Meet link or title" : "not looked up yet");
      }
    } catch {
    }
    return rows;
  }
  var checkupText = (rows) => rows.map((r) => `${r.level} ${r.title}${r.detail ? `: ${r.detail}` : ""}`).join("\n");

  // src/recipients.js
  var EMAIL2 = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var emailsIn = (text) => [...new Set((String(text || "").match(EMAIL2) || []).map((x2) => x2.toLowerCase()))];
  var looksValid = (x2) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(x2).trim());
  function rowsFrom(listText, groupsText) {
    const rows = emailsIn(listText).map((email) => ({ email, group: "" }));
    for (const raw of String(groupsText || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || !line.includes("|")) continue;
      const i = line.indexOf("|");
      const group = line.slice(0, i).trim();
      for (const email of emailsIn(line.slice(i + 1))) rows.push({ email, group });
    }
    return rows;
  }
  function textsFrom(rows) {
    const ok = rows.filter((r) => looksValid(r.email));
    const list = [...new Set(ok.filter((r) => !r.group.trim()).map((r) => r.email.trim().toLowerCase()))].join(", ");
    const groups = /* @__PURE__ */ new Map();
    for (const r of ok.filter((x2) => x2.group.trim())) {
      const g = r.group.trim().replace(/\|/g, " ");
      if (!groups.has(g)) groups.set(g, /* @__PURE__ */ new Set());
      groups.get(g).add(r.email.trim().toLowerCase());
    }
    return { list, groups: [...groups].map(([g, set]) => `${g} | ${[...set].join(", ")}`).join("\n") };
  }
  function mountRecipients(host, listTa, groupsTa) {
    if (!host || !listTa) return;
    let rows = [];
    const blank = () => ({ email: "", group: "" });
    const make = (tag, props = {}, ...kids) => {
      const e = document.createElement(tag);
      for (const [k2, v] of Object.entries(props)) {
        if (k2 === "class") e.className = v;
        else if (k2.startsWith("on")) e[k2] = v;
        else if (v != null && v !== false) e.setAttribute(k2, v === true ? "" : v);
      }
      e.append(...kids.filter((x2) => x2 != null));
      return e;
    };
    const emit = () => {
      const t = textsFrom(rows);
      listTa.value = t.list;
      listTa.dispatchEvent(new Event("input", { bubbles: true }));
      if (groupsTa) {
        groupsTa.value = t.groups;
        groupsTa.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    function draw(focus) {
      host.replaceChildren();
      const head = make("div", { class: `rec-row rec-head${groupsTa ? "" : " one"}`, role: "row" }, make("span", { role: "columnheader" }, "Email"), groupsTa ? make("span", { role: "columnheader" }, "Only for meetings titled\u2026") : null, make("span"));
      const body = make("div", { class: "rec-body", role: "rowgroup" });
      rows.forEach((r, ri) => {
        const email = make("input", { class: "rec-in", type: "text", inputmode: "email", value: r.email, placeholder: ri === 0 ? "priya@company.com" : "", "aria-label": `Email, person ${ri + 1}`, autocomplete: "off", spellcheck: "false" });
        const mark = () => email.setAttribute("aria-invalid", String(!!email.value.trim() && !looksValid(email.value)));
        mark();
        email.addEventListener("input", () => {
          r.email = email.value;
          mark();
          emit();
        });
        email.addEventListener("paste", (e) => {
          const found = emailsIn(e.clipboardData?.getData("text") || "");
          if (found.length < 2) return;
          e.preventDefault();
          rows.splice(ri, 1, ...found.map((x2) => ({ email: x2, group: r.group })));
          emit();
          draw();
        });
        email.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          rows.splice(ri + 1, 0, { email: "", group: r.group });
          emit();
          draw(`${ri + 1}.email`);
        });
        email.dataset.key = `${ri}.email`;
        const group = groupsTa ? make("input", { class: "rec-in", type: "text", value: r.group, placeholder: "all meetings", "aria-label": `Only for meetings titled, person ${ri + 1}`, autocomplete: "off" }) : null;
        group?.addEventListener("input", () => {
          r.group = group.value;
          emit();
        });
        const del = make("button", { class: "rec-x", type: "button", title: "Remove", "aria-label": `Remove ${r.email || `person ${ri + 1}`}` }, "\xD7");
        del.addEventListener("click", () => {
          rows.splice(ri, 1);
          emit();
          draw();
        });
        body.append(make("div", { class: `rec-row${groupsTa ? "" : " one"}`, role: "row" }, email, group, del));
      });
      const add = make("button", { class: "btn sm", type: "button" }, "+ Add a person");
      add.addEventListener("click", () => {
        rows.push(blank());
        draw(`${rows.length - 1}.email`);
      });
      host.append(make("div", { class: "rec-table", role: "table", "aria-label": "Who else gets a copy" }, head, body), make("div", { class: "rec-foot" }, add, make("span", { class: "hint" }, groupsTa ? "Leave the second box empty for people who get every meeting. Words from a meeting title (like Cadence Call) give that meeting its own list." : "Paste several addresses at once if you like.")));
      if (focus) host.querySelector(`[data-key="${focus}"]`)?.focus();
    }
    const load = () => {
      rows = rowsFrom(listTa.value, groupsTa?.value);
      if (!rows.length) rows = [blank()];
      draw();
    };
    listTa.hidden = true;
    if (groupsTa) groupsTa.hidden = true;
    listTa.addEventListener("rec-refresh", load);
    load();
  }

  // src/backupkeys.js
  function mountBackupKeys(host, addButton) {
    if (!host || !addButton) return { value: () => [], set() {
    } };
    let saved = [];
    let removed2 = /* @__PURE__ */ new Set();
    let fresh = [];
    const make = (tag, props = {}, ...kids) => {
      const e = document.createElement(tag);
      for (const [k2, v] of Object.entries(props)) {
        if (k2 === "class") e.className = v;
        else if (k2.startsWith("on")) e[k2] = v;
        else if (v != null && v !== false) e.setAttribute(k2, v === true ? "" : v);
      }
      e.append(...kids.filter((x2) => x2 != null));
      return e;
    };
    const changed = () => host.dispatchEvent(new Event("input", { bubbles: true }));
    function draw() {
      host.replaceChildren();
      let n = 2;
      saved.forEach((_2, i) => {
        if (removed2.has(i)) return;
        const label = `Backup key ${n}`;
        n++;
        const rm = make("button", { class: "btn sm", type: "button", "aria-label": `Remove ${label}` }, "Remove");
        rm.addEventListener("click", () => {
          removed2.add(i);
          draw();
          changed();
        });
        host.append(make("div", { class: "bk-row" }, make("span", { class: "bk-name" }, label), make("span", { class: "secret-mask bk-mask", "aria-label": "A key is saved" }, "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"), make("span", { class: "chip ok" }, "Saved"), rm));
      });
      fresh.forEach((f, i) => {
        const label = `Backup key ${n}`;
        n++;
        const input = make("input", { class: "bk-in", type: "password", autocomplete: "new-password", spellcheck: "false", placeholder: "A key from another Google project", "aria-label": label });
        input.value = f.v;
        input.addEventListener("input", () => {
          f.v = input.value;
        });
        const rm = make("button", { class: "btn sm", type: "button", "aria-label": `Discard ${label}` }, "Discard");
        rm.addEventListener("click", () => {
          fresh.splice(i, 1);
          draw();
          changed();
        });
        host.append(make("div", { class: "bk-row" }, make("label", { class: "bk-name" }, label), input, rm));
        if (f.focus) {
          f.focus = false;
          queueMicrotask(() => input.focus());
        }
      });
    }
    addButton.addEventListener("click", () => {
      fresh.push({ v: "", focus: true });
      draw();
    });
    return {
      // the keys as they should be stored: the saved ones that were not removed, then the new ones typed in
      value() {
        return [...saved.filter((_2, i) => !removed2.has(i)), ...fresh.map((f) => f.v.trim()).filter(Boolean)];
      },
      // after loading or saving: these keys are the saved ones now
      set(list) {
        saved = Array.isArray(list) ? list.filter(Boolean) : [];
        removed2 = /* @__PURE__ */ new Set();
        fresh = [];
        draw();
      }
    };
  }

  // src/options.js
  var $3 = (id) => document.getElementById(id);
  var FIELDS2 = Object.keys(DEFAULTS);
  var el2 = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };
  var SECRETS = ["geminiKey", "geminiKey2", "sarvamKey", "deepgramKey", "sttKey", "anthropicKey", "oaKey"];
  var stored = {};
  var removed = /* @__PURE__ */ new Set();
  var editing = /* @__PURE__ */ new Set();
  var secretUi = {};
  function secretValue(k2) {
    const v = $3(k2).value.trim();
    return v || (removed.has(k2) ? "" : stored[k2] || "");
  }
  function renderSecret(k2) {
    const u = secretUi[k2];
    if (!u) return;
    const input = $3(k2);
    const has = !!stored[k2] && !removed.has(k2);
    const masked = has && !editing.has(k2);
    u.mask.hidden = !masked;
    input.hidden = masked;
    u.replace.hidden = !masked;
    u.keep.hidden = !(has && editing.has(k2) || removed.has(k2));
    u.keep.textContent = removed.has(k2) ? "Undo remove" : "Keep current";
    u.remove.hidden = !(has && editing.has(k2));
    u.note.hidden = false;
    u.note.replaceChildren();
    if (masked) u.note.append(el2("span", { className: "chip ok", textContent: "Saved" }), "On this computer only. Never shown again.");
    else if (removed.has(k2)) u.note.append("The key will be removed when you press Save changes.");
    else if (has) u.note.append("Type the new key. Leave it empty, or press Escape, to keep the current one.");
    else u.note.hidden = true;
  }
  function renderSecrets() {
    SECRETS.forEach(renderSecret);
  }
  function initSecrets() {
    for (const k2 of SECRETS) {
      const input = $3(k2);
      if (!input) continue;
      const label = document.querySelector(`label[for="${k2}"]`);
      if (label && !label.id) label.id = `${k2}-lbl`;
      const name = label ? label.firstChild.textContent.trim() : "key";
      const mask = el2("div", { className: "secret-mask", textContent: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" });
      mask.setAttribute("role", "img");
      mask.setAttribute("aria-label", `${name}: saved, hidden`);
      const replace = el2("button", { type: "button", className: "btn", textContent: "Replace" });
      replace.setAttribute("aria-label", `Replace ${name.toLowerCase()}`);
      const keep = el2("button", { type: "button", className: "btn ghost", textContent: "Keep current" });
      const remove2 = el2("button", { type: "button", className: "btn ghost", textContent: "Remove" });
      remove2.style.color = "var(--rec-ink)";
      remove2.setAttribute("aria-label", `Remove ${name.toLowerCase()}`);
      const note2 = el2("p", { className: "secret-note" });
      input.before(mask);
      input.after(replace, keep, remove2, note2);
      secretUi[k2] = { mask, replace, keep, remove: remove2, note: note2 };
      replace.onclick = () => {
        editing.add(k2);
        renderSecret(k2);
        input.focus();
      };
      const revert = () => {
        removed.delete(k2);
        editing.delete(k2);
        input.value = "";
        renderSecret(k2);
        replace.focus();
        updateDirty();
      };
      keep.onclick = revert;
      remove2.onclick = () => {
        removed.add(k2);
        editing.add(k2);
        input.value = "";
        renderSecret(k2);
        keep.focus();
        updateDirty();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && stored[k2] && !input.hidden) {
          e.preventDefault();
          revert();
        }
      });
    }
  }
  function clearSecret(k2) {
    $3(k2).value = "";
    if (stored[k2]) {
      removed.add(k2);
      editing.add(k2);
    }
    renderSecret(k2);
  }
  var backupKeys = mountBackupKeys($3("moreKeys"), $3("addKey"));
  function read() {
    const s = {};
    for (const k2 of FIELDS2) {
      const f = $3(k2);
      if (!f) continue;
      s[k2] = SECRETS.includes(k2) ? secretValue(k2) : f.type === "checkbox" ? f.checked : f.value.trim();
    }
    s.geminiBackups = backupKeys.value();
    s.shareMode = $3("shareAuto").checked ? "auto" : "review";
    s.meetingLanguages = [...document.querySelectorAll("#langChips input:checked")].map((c) => c.dataset.lang);
    return s;
  }
  function fill(s) {
    for (const k2 of FIELDS2) {
      const f = $3(k2);
      if (!f) continue;
      if (SECRETS.includes(k2)) {
        stored[k2] = s[k2] || "";
        f.value = "";
      } else if (f.type === "checkbox") f.checked = !!s[k2];
      else f.value = s[k2] ?? "";
    }
    $3("peopleDirectory")?.dispatchEvent(new Event("dir-refresh"));
    $3("shareList")?.dispatchEvent(new Event("rec-refresh"));
    backupKeys.set(s.geminiBackups);
    removed.clear();
    editing.clear();
    $3("shareAuto").checked = s.shareMode === "auto";
    renderSecrets();
  }
  var MODE_NOTE = {
    thorough: "Finds every item first, writes the minutes, then checks that nothing was missed.",
    quick: "One pass over the transcript. Lighter on a free quota; may miss small items in long meetings."
  };
  function arrowKeys(buttons, pick) {
    buttons.forEach((b, i) => {
      b.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = buttons[(i + d + buttons.length) % buttons.length];
        next.focus();
        pick(next);
      });
    });
  }
  function initSegs() {
    document.querySelectorAll("[data-seg-for]").forEach((box) => {
      const sel = $3(box.dataset.segFor);
      const btns = [...box.querySelectorAll("button")];
      const sync = () => {
        btns.forEach((b) => {
          const on = b.dataset.v === sel.value;
          b.setAttribute("aria-checked", String(on));
          b.tabIndex = on ? 0 : -1;
        });
        if (sel.id === "minutesMode") $3("minutesModeNote").textContent = MODE_NOTE[sel.value] || "";
      };
      const pick = (b) => {
        sel.value = b.dataset.v;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      };
      btns.forEach((b) => b.onclick = () => pick(b));
      arrowKeys(btns, pick);
      sel.addEventListener("change", sync);
      box._sync = sync;
      sync();
    });
  }
  var syncSegs = () => document.querySelectorAll("[data-seg-for]").forEach((b) => b._sync());
  function showTab(name) {
    if (!document.getElementById(`page-${name}`)) name = "start";
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${name}`));
    document.querySelectorAll("#nav button").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("#nav button").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  document.querySelectorAll("[data-go]").forEach((a) => a.onclick = () => showTab(a.dataset.go));
  async function renderLearned() {
    const { learned } = await chrome.storage.local.get("learned");
    const names2 = Object.keys(learned?.names || {});
    $3("learnedNames").textContent = names2.length ? names2.slice(-60).join(", ") : "None yet. Names are learned from your meetings.";
    const pending = learned?.pending || [];
    $3("pendingEmpty").classList.toggle("hidden", pending.length > 0);
    $3("pendingList").replaceChildren(
      ...pending.map((p) => {
        const row = el2("div", { className: "prow" });
        const t = el2("span", { className: "who" }, el2("b", { textContent: p.suggest }), " was heard as ", el2("b", { textContent: p.found }));
        const meta = el2("span", { className: "hint", textContent: `${p.count}\xD7 \xB7 ${p.meeting || "a meeting"}` });
        const ok = el2("button", { type: "button", className: "btn sm primary", textContent: "Fix it from now on" });
        const no = el2("button", { type: "button", className: "btn sm", textContent: "Dismiss" });
        ok.onclick = async () => {
          $3("dictionary").value = learnAlias($3("dictionary").value, p.suggest, p.found);
          await save2();
          await chrome.storage.local.set({ learned: { ...learned, pending: pending.filter((x2) => x2.id !== p.id) } });
        };
        no.onclick = async () => chrome.storage.local.set({ learned: { ...learned, pending: pending.filter((x2) => x2.id !== p.id), rejected: [...learned.rejected || [], p.id] } });
        row.append(t, meta, ok, no);
        return row;
      })
    );
  }
  $3("clearLearned").onclick = async () => {
    const { learned } = await chrome.storage.local.get("learned");
    await chrome.storage.local.set({ learned: { ...learned, names: {} } });
  };
  chrome.storage.onChanged.addListener((c) => {
    if (c.learned) renderLearned();
  });
  var usageDays = 1;
  var fmtN = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  var KIND = { stt: "Speech to text", llm: "Minutes" };
  var RANGE = { 1: "today", 7: "in the last 7 days", 30: "in the last 30 days" };
  async function renderUsage() {
    const { usage, learnedLimits = {} } = await chrome.storage.local.get(["usage", "learnedLimits"]);
    const settings = await getSettings();
    const typed = parseLimits($3("usageLimits").value || settings.usageLimits);
    const limits = { ...learnedLimits, ...typed };
    const rows = summarize(usage, usageDays);
    const prices = parsePrices($3("usagePrices").value || settings.usagePrices);
    const today = summarize(usage, 1);
    const table = $3("usageTable");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    [
      ["Service and model", ""],
      ["Used for", ""],
      ["Requests", "num"],
      ["Failed (rate limit)", "num"],
      ["Tokens in / out", "num"],
      ["Audio", "num"],
      ["Cost if paid", "num"],
      [usageDays === 1 ? "Left today" : "", ""]
    ].forEach(([h2, cls]) => head.append(Object.assign(document.createElement("th"), { textContent: h2, className: cls })));
    const body = table.createTBody();
    if (!rows.length) {
      const r = body.insertRow();
      const c = r.insertCell();
      c.colSpan = 8;
      c.textContent = "Nothing yet. Counts start with your next recording.";
      c.style.color = "var(--muted)";
    }
    for (const r of rows) {
      const tr = body.insertRow();
      const cell = (t, cls) => Object.assign(tr.insertCell(), { textContent: t, className: cls || "" });
      const svc = tr.insertCell();
      svc.append(el2("span", { className: "svc", textContent: r.provider }));
      if (r.model && r.model !== "-") svc.append(el2("span", { className: "sr-only", textContent: " \xB7 " }), el2("div", { className: "hint", textContent: r.model }));
      cell(KIND[r.kind] || r.kind);
      cell(String(r.req), "num");
      cell(r.fail ? `${r.fail}${r.rl ? ` (${r.rl} limit)` : ""}` : "0", `num${r.fail ? " fail" : ""}`);
      cell(r.tin || r.tout ? `${fmtN(r.tin)} / ${fmtN(r.tout)}` : "-", "num");
      cell(r.audioSec ? `${Math.round(r.audioSec / 60)} min` : "-", "num");
      const paid2 = paidCost(r, prices);
      cell(paid2.usd == null ? "\u2014" : r.fail && !r.tin && !r.tout ? rupees(0, $3("usdInr").value) : `${paid2.assumed ? "~" : ""}${rupees(paid2.usd, $3("usdInr").value)}`, "num cost");
      const left = tr.insertCell();
      left.className = "usage-left";
      const limit = limits[r.model];
      if (usageDays === 1 && limit) {
        const used = today.filter((x2) => x2.model === r.model).reduce((a, x2) => a + x2.req, 0);
        const remaining = Math.max(0, limit - used);
        const pct = Math.max(0, Math.min(100, Math.round(remaining / limit * 100)));
        const meter = el2("div", { className: "meter" }, el2("i", { className: pct === 0 ? "s" : pct <= 20 ? "q" : "" }));
        meter.firstChild.style.width = `${pct}%`;
        meter.setAttribute("role", "meter");
        meter.setAttribute("aria-valuemin", "0");
        meter.setAttribute("aria-valuemax", "100");
        meter.setAttribute("aria-valuenow", String(pct));
        meter.setAttribute("aria-label", `${r.model} left today`);
        left.append(meter, el2("div", { className: `hint${pct <= 20 ? " low" : ""}`, textContent: `${remaining} of ${limit} left` }));
      } else if (usageDays === 1) left.append(el2("span", { className: "hint", textContent: "No daily limit" }));
    }
    const reqs = rows.reduce((a, r) => a + r.req, 0);
    const audio = rows.filter((r) => r.kind === "stt").reduce((a, r) => a + r.audioSec, 0);
    const cost = estimateCost(rows, prices);
    const paid = paidTotal(rows, prices);
    const tn = $3("tildeNote");
    if (tn) tn.style.display = table.textContent.includes("~") ? "flex" : "none";
    $3("usageTotals").replaceChildren(
      el2("strong", { textContent: `Total ${RANGE[usageDays] || ""}`.trim() }),
      el2("span", { textContent: `${reqs} request${reqs === 1 ? "" : "s"}` }),
      el2("span", { textContent: `${Math.round(audio / 60)} min of audio transcribed` }),
      ...cost != null ? [el2("span", { textContent: `about ${rupees(cost, $3("usdInr").value)} at your prices` })] : [],
      el2("span", { className: "paid", textContent: `If this were paid: about ${rupees(paid.usd, $3("usdInr").value)}${paid.assumed ? " (Gemini Flash list prices assumed where you set none)" : ""}${paid.unknown ? `, ${paid.unknown} line(s) unpriced` : ""}` }),
      el2("span", { className: "hint", style: "margin-left:auto", textContent: `Daily quota resets at ${istClock(nextQuotaReset())} (midnight Pacific)` })
    );
  }
  var rangeBtns = [...document.querySelectorAll("#usageRange button")];
  var pickRange = (b) => {
    usageDays = Number(b.dataset.days);
    rangeBtns.forEach((x2) => {
      x2.classList.toggle("active", x2 === b);
      x2.setAttribute("aria-selected", String(x2 === b));
      x2.tabIndex = x2 === b ? 0 : -1;
    });
    renderUsage();
  };
  rangeBtns.forEach((b) => {
    b.onclick = () => pickRange(b);
    b.tabIndex = b.classList.contains("active") ? 0 : -1;
  });
  arrowKeys(rangeBtns, pickRange);
  $3("usageReset").onclick = async () => {
    const r = await modal({ text: "Reset all usage counters? This only clears Debrief's own tally.", buttons: [{ label: "Cancel", value: "no" }, { label: "Reset counters", value: "yes", danger: true }] });
    if (r?.value !== "yes") return;
    await chrome.storage.local.remove(["usage", "learnedLimits"]);
    renderUsage();
  };
  $3("usageLimits").addEventListener("input", renderUsage);
  $3("usagePrices").addEventListener("input", renderUsage);
  $3("usdInr").addEventListener("input", renderUsage);
  chrome.storage.onChanged.addListener((c) => {
    if (c.usage || c.learnedLimits) renderUsage();
  });
  function showProviderFields() {
    document.querySelectorAll("[data-stt]").forEach((f) => f.classList.toggle("hidden", f.dataset.stt !== $3("sttProvider").value));
    document.querySelectorAll("[data-llm]").forEach((f) => f.classList.toggle("hidden", f.dataset.llm !== $3("llmProvider").value));
  }
  async function requestOrigins(s) {
    const urls = [];
    if (s.sttProvider === "openai") urls.push(s.sttBase);
    if (s.llmProvider === "openai") urls.push(s.oaBase);
    const origins = [];
    for (const u of urls) {
      if (u && !isLocalBase(u) && !/^https:\/\//i.test(u)) throw new Error(`Use an https address for ${u}. Only addresses on this computer may use http.`);
      try {
        origins.push(`${new URL(u).origin}/*`);
      } catch {
        throw new Error(`Invalid base URL: ${u}`);
      }
    }
    if (!origins.length || await chrome.permissions.contains({ origins })) return;
    if (!await chrome.permissions.request({ origins })) throw new Error("Permission for the custom endpoint was denied.");
  }
  function buildLanguageUi() {
    $3("langChips").replaceChildren(
      ...LANGUAGES.map((l3) => {
        const label = document.createElement("label");
        label.className = "pick";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.lang = l3.code;
        cb.onchange = langHint;
        label.append(cb, l3.name);
        return label;
      })
    );
    $3("momLanguage").replaceChildren(...minutesLanguageOptions().map((o) => Object.assign(document.createElement("option"), { value: o.value, textContent: o.label })));
  }
  function setLanguageCodes(codes) {
    const set = new Set(codes);
    document.querySelectorAll("#langChips input").forEach((c) => c.checked = set.has(c.dataset.lang));
    langHint();
  }
  function setLanguages(s) {
    setLanguageCodes((chosenLanguages(s) || []).map((l3) => l3.code));
  }
  function langHint() {
    const picked = LANGUAGES.filter((l3) => document.querySelector(`#langChips input[data-lang="${l3.code}"]`)?.checked);
    $3("langHint").textContent = picked.length ? `Debrief will expect ${names(picked)}, in any mix. Fewer choices give more accurate text.` : "Nothing selected: automatic (Hindi, English and Malayalam are expected, and others are detected). Pick the languages your meetings really use for better accuracy.";
  }
  var loaded = {};
  var ready = false;
  var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function save2() {
    const vals = read();
    const out = { ...await getSettings() };
    for (const k2 of Object.keys(vals)) if (!same(vals[k2], loaded[k2])) out[k2] = vals[k2];
    await requestOrigins(out);
    await saveSettings(out);
    loaded = vals;
    for (const k2 of SECRETS) if ($3(k2)) stored[k2] = vals[k2];
    removed.clear();
    editing.clear();
    for (const k2 of SECRETS) if ($3(k2)) $3(k2).value = "";
    renderSecrets();
    updateDirty();
    return out;
  }
  var flash = null;
  var flashTimer = 0;
  var isDirty = () => {
    if (!ready) return false;
    const v = read();
    return Object.keys(v).some((k2) => !same(v[k2], loaded[k2]));
  };
  function updateDirty() {
    const bar = $3("savebar");
    const dirty = isDirty();
    bar.classList.toggle("dirty", dirty && !flash);
    bar.classList.toggle("saved", flash?.kind === "saved");
    bar.classList.toggle("bad", flash?.kind === "bad");
    $3("undo").hidden = !dirty;
    $3("msg").textContent = flash ? flash.text : dirty ? "You have unsaved changes" : "All changes saved";
  }
  function showFlash(kind, text, ms) {
    flash = { kind, text };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      updateDirty();
    }, ms);
    updateDirty();
  }
  function applyValues(v) {
    fill(v);
    setLanguageCodes(v.meetingLanguages || []);
    showProviderFields();
    syncSegs();
    renderAllow();
    renderUsage();
  }
  document.querySelector(".content").addEventListener("input", () => {
    if (flash?.kind === "saved") flash = null;
    updateDirty();
  });
  document.querySelector(".content").addEventListener("change", () => {
    if (flash?.kind === "saved") flash = null;
    updateDirty();
  });
  $3("undo").onclick = () => {
    applyValues(loaded);
    updateDirty();
    $3("save").focus();
  };
  async function micStatus() {
    try {
      const p = await navigator.permissions.query({ name: "microphone" });
      $3("micStatus").textContent = p.state === "granted" ? "Microphone allowed \u2713" : p.state === "denied" ? "Blocked in Chrome. Allow it in the address bar or Chrome settings." : "Not allowed yet";
      $3("micStatus").classList.toggle("ok", p.state === "granted");
    } catch {
    }
  }
  $3("sttProvider").onchange = showProviderFields;
  $3("llmProvider").onchange = showProviderFields;
  $3("save").onclick = async () => {
    try {
      await save2();
      showFlash("saved", "Saved \u2713", 3e3);
      updateGuide();
    } catch (e) {
      showFlash("bad", e.message, 7e3);
    }
  };
  $3("grantMic").onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      $3("micStatus").textContent = `Not allowed: ${e.message}`;
      return;
    }
    micStatus();
    updateGuide();
  };
  $3("useOllama").onclick = () => {
    $3("llmProvider").value = "openai";
    showProviderFields();
    $3("oaBase").value = OLLAMA_BASE;
    clearSecret("oaKey");
    $3("localStatus").textContent = 'Set to Ollama (http://localhost:11434/v1). Press "Find my installed models" to pick one.';
    updateDirty();
  };
  $3("findOllama").onclick = async () => {
    $3("localStatus").textContent = "Looking for Ollama\u2026";
    const base = $3("oaBase").value.trim() || OLLAMA_BASE;
    const r = await listOllamaModels(base);
    if (!r.ok) {
      $3("ollamaPick").classList.add("hidden");
      $3("localStatus").textContent = r.message;
      return;
    }
    const sel = $3("ollamaModels");
    sel.replaceChildren(...r.models.map((m) => Object.assign(document.createElement("option"), { value: m.name, textContent: `${m.name}${m.sizeGB ? ` (${m.sizeGB} GB)` : ""}` })));
    if (r.models.some((m) => m.name === $3("oaModel").value)) sel.value = $3("oaModel").value;
    $3("ollamaPick").classList.remove("hidden");
    const pick = async () => {
      $3("oaBase").value = base;
      $3("oaModel").value = sel.value;
      updateDirty();
      const ctx = await ollamaContext(sel.value, base);
      $3("localStatus").textContent = `Using ${sel.value}. ${contextAdvice(ctx)}`;
    };
    sel.onchange = pick;
    await pick();
  };
  $3("useWhisper").onclick = () => {
    $3("sttProvider").value = "openai";
    showProviderFields();
    $3("sttBase").value = WHISPER_BASE;
    clearSecret("sttKey");
    $3("whisperStatus").textContent = "Set to http://localhost:8000/v1. Change the address if your server uses another port.";
    updateDirty();
  };
  $3("testWhisper").onclick = async () => {
    $3("whisperStatus").textContent = "Testing\u2026";
    const base = ($3("sttBase").value.trim() || WHISPER_BASE).replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(6e3) });
      $3("whisperStatus").textContent = res.ok ? "The server answered \u2713" : explain(null, res.status, "The server");
    } catch (e) {
      $3("whisperStatus").textContent = explain(e, 0, "the server");
    }
  };
  $3("testLlm").onclick = async () => {
    $3("llmStatus").textContent = "Testing\u2026";
    try {
      const settings = await save2();
      const ping = (s) => generate({ settings: s, system: "You are a connectivity test.", user: "Reply with exactly: OK", onText: () => {
      } });
      const runs = [["Main", { ...settings, geminiKey2: "", geminiBackups: [] }]];
      if (settings.llmProvider === "gemini") {
        [settings.geminiKey2, ...settings.geminiBackups || []].filter(Boolean).forEach((k2, i) => runs.push([`Backup ${i + 1}`, { ...settings, geminiKey: k2, geminiKey2: "", geminiBackups: [] }]));
      }
      const results = [];
      for (const [label, s] of runs) {
        try {
          const text = await ping(s);
          results.push(`${label}: works \u2713 ("${text.trim().slice(0, 20)}")`);
        } catch (e) {
          results.push(`${label}: failed: ${e.message.slice(0, 150)}`);
        }
      }
      $3("llmStatus").textContent = results.join(" \xB7 ");
    } catch (e) {
      $3("llmStatus").textContent = `Failed: ${e.message}`;
    }
  };
  async function updateGuide() {
    const s = await getSettings();
    const mic = await navigator.permissions.query({ name: "microphone" }).then((p) => p.state === "granted").catch(() => false);
    const needsGemini = s.sttProvider === "gemini" || s.llmProvider === "gemini";
    const langs = (chosenLanguages(s) || []).map((l3) => l3.name).join(", ");
    const done = { g1: !!s.geminiKey || !needsGemini, g2: mic, g3: !!s.myName, g4: mailReady(s) };
    const text = {
      g1: done.g1 ? s.geminiKey ? "Gemini key saved" : "No Gemini key needed: you use other services" : "Add your Gemini key",
      g2: done.g2 ? "Microphone allowed" : "Allow your microphone",
      g3: done.g3 ? `Name and languages: ${s.myName} \xB7 ${langs || "automatic"}` : "Set your name and languages",
      g4: done.g4 ? "Email is set up" : "Email the minutes to yourself"
    };
    for (const [id, ok] of Object.entries(done)) {
      const row = $3(id);
      if (!row) continue;
      row.classList.toggle("done", ok);
      row.querySelector(".ic").textContent = ok ? "\u2713" : id.slice(1);
      row.querySelector("[data-text]").textContent = text[id];
      row.querySelector("[data-state]").textContent = ok ? "Done. " : "Not done. ";
      const opt = row.querySelector("[data-opt]");
      if (opt) opt.hidden = ok;
    }
    const n = Object.values(done).filter(Boolean).length;
    $3("startLede").textContent = n === 4 ? "Everything is set up. Debrief is ready to record your next meeting." : `Four things make Debrief work. ${["None", "One", "Two", "Three"][n]} ${n === 1 ? "is" : "are"} done.`;
  }
  $3("g1go").onclick = () => {
    showTab("start");
    const f = $3("geminiKey");
    (f.hidden ? secretUi.geminiKey.replace : f).focus();
  };
  function allAllowed() {
    return parseAddresses([$3("shareList").value, ...parseGroups($3("shareGroups").value).map((g) => g.list.join(","))].join(","));
  }
  function renderAllow() {
    const l3 = allowListLines(allAllowed(), { domains: $3("shareDomains").checked });
    $3("allowLines").textContent = `const ALLOWED = ${l3.allowed};
const ALLOWED_DOMAINS = ${l3.domains};`;
  }
  ["shareList", "shareGroups"].forEach((id) => $3(id).addEventListener("input", renderAllow));
  $3("shareDomains").addEventListener("change", renderAllow);
  $3("copyScriptAllow").onclick = async () => {
    await navigator.clipboard.writeText(scriptWithAllowList(Code_default, allAllowed(), { domains: $3("shareDomains").checked, secret: await ensureEmailSecret() }));
    $3("copyAllowMsg").textContent = "Copied. Paste it over your script, save, then deploy a new version.";
    setTimeout(() => $3("copyAllowMsg").textContent = "", 6e3);
  };
  $3("scriptText").textContent = Code_default;
  $3("copyScript").onclick = async () => {
    await navigator.clipboard.writeText(scriptWithSecret(Code_default, await ensureEmailSecret()));
    $3("copyMsg").textContent = "Copied \u2713";
    setTimeout(() => $3("copyMsg").textContent = "", 1500);
  };
  var LEVEL = { "\u2713": ["ok", "Working"], "!": ["warn", "Warning"], "\u2717": ["bad", "Not working"] };
  function renderChecks(rows) {
    $3("checkupOut").replaceChildren(
      ...rows.map((r) => {
        const [cls, sr] = LEVEL[r.level] || LEVEL["!"];
        const ic = el2("span", { className: `ic lv-${cls}`, textContent: r.level });
        ic.setAttribute("aria-label", sr);
        const name = el2("b", {}, r.title, el2("span", { className: "sr-only", textContent: ": " }));
        const body = el2("div", { className: "ck" }, name);
        if (r.detail) body.append(el2("p", { className: "hint", textContent: r.detail }));
        const li = el2("li", {}, ic, body);
        if (r.go && r.level !== "\u2713") {
          const fix = el2("button", { type: "button", className: "btn sm", textContent: r.fixText || "Open settings" });
          fix.onclick = () => showTab(r.go);
          li.append(fix);
        }
        return li;
      })
    );
  }
  $3("checkup").onclick = async () => {
    $3("checkup").disabled = true;
    $3("checkupMsg").textContent = "Checking\u2026";
    try {
      const rows = await runCheckup();
      const text = checkupText(rows);
      renderChecks(rows);
      $3("checkupOut").hidden = false;
      $3("checkupCopy").hidden = false;
      $3("checkup").textContent = "Check again";
      const bad = rows.filter((r) => r.level === "\u2717").length;
      const warn = rows.filter((r) => r.level === "!").length;
      const summary = bad ? `${bad} problem${bad === 1 ? "" : "s"}, ${warn} to look at` : warn ? `No problems, ${warn} to look at` : "All good";
      $3("checkupMsg").textContent = summary;
      $3("checkupCopy").onclick = async () => {
        await navigator.clipboard.writeText(text);
        $3("checkupMsg").textContent = `Copied \u2713 ${summary}`;
      };
    } catch (e) {
      $3("checkupMsg").textContent = `Could not check: ${e.message}`;
    } finally {
      $3("checkup").disabled = false;
    }
  };
  $3("testMail").onclick = async () => {
    $3("mailMsg").textContent = "Sending\u2026";
    try {
      const s = await save2();
      if (!mailReady(s)) throw new Error(/\/dev(\?|$)/.test(s.emailWebhook || "") ? "That is the test URL (ends in /dev). Use Deploy \u2192 New deployment, and paste the Web app URL that ends in /exec." : "Paste the Apps Script web app URL: https://script.google.com/\u2026/exec (company accounts have /a/macros/yourcompany.com/ in it).");
      const r = await sendMail(
        {
          subject: "Debrief test email",
          html: "<p>This is a test from <b>Debrief</b>. Your minutes will arrive like this.</p>",
          text: "This is a test from Debrief. Your minutes will arrive like this.",
          attachments: []
        },
        s
      );
      $3("mailMsg").textContent = `Sent to ${r.to} \u2713 Check your inbox.`;
    } catch (e) {
      $3("mailMsg").textContent = `Failed: ${e.message}`;
    }
  };
  var fmtSeg = () => document.querySelectorAll("#minutesFormatSeg button").forEach((b) => b.classList.toggle("active", b.dataset.v === $3("minutesFormat").value));
  document.querySelectorAll("#minutesFormatSeg button").forEach((b) => b.onclick = () => {
    $3("minutesFormat").value = b.dataset.v;
    fmtSeg();
  });
  $3("useAmnexPreset").onclick = () => {
    for (const [k2, v] of Object.entries(AMNEX_PRESET)) $3(k2).value = v;
    $3("minutesFormat").value = "amnex";
    fmtSeg();
    $3("presetMsg").textContent = "Filled in. Press Save changes to keep it.";
  };
  (async () => {
    const s = await getSettings();
    buildLanguageUi();
    initSecrets();
    initSegs();
    mountDirectoryTable($3("peopleDirectory"), $3("dirTable"));
    $3("goPeople")?.addEventListener("click", (e) => {
      e.preventDefault();
      showTab("voices");
      $3("peopleCard")?.scrollIntoView({ block: "start" });
    });
    mountRecipients($3("recTable"), $3("shareList"), $3("shareGroups"));
    fill(s);
    setLanguages(s);
    fmtSeg();
    loaded = read();
    ready = true;
    showProviderFields();
    syncSegs();
    renderAllow();
    micStatus();
    updateGuide();
    renderUsage();
    renderLearned();
    initVoices();
    updateDirty();
    showTab(location.hash.slice(1) || "start");
  })();
  chrome.storage.onChanged.addListener(async (changes) => {
    if (!changes.settings || !ready) return;
    const fresh = await getSettings();
    for (const k2 of FIELDS2) {
      const f = $3(k2);
      if (!f || !same(read()[k2], loaded[k2])) continue;
      if (SECRETS.includes(k2)) {
        stored[k2] = fresh[k2] || "";
        renderSecret(k2);
      } else if (f.type === "checkbox") f.checked = !!fresh[k2];
      else f.value = fresh[k2];
      loaded[k2] = fresh[k2];
    }
    $3("shareAuto").checked = fresh.shareMode === "auto";
    loaded.shareMode = fresh.shareMode;
    fmtSeg();
    if (same(read().meetingLanguages, loaded.meetingLanguages)) {
      setLanguages(fresh);
      loaded.meetingLanguages = read().meetingLanguages;
    }
    syncSegs();
    updateDirty();
    updateGuide();
  });
})();
