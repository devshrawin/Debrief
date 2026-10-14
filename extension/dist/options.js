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
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, x < 0 ? x * 32768 : x * 32767, true);
    }
    return new Blob([buf], { type: "audio/wav" });
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
  async function tx(store, mode2, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, mode2);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out?.result ?? out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
  var getSample = (personId) => tx("samples", "readonly", (s) => s.get(personId));
  var hasSample = async (personId) => !!await getSample(personId);
  var deleteSample = (personId) => tx("samples", "readwrite", (s) => s.delete(personId));
  async function clearAllAudio() {
    await tx("pieces", "readwrite", (s) => s.clear());
    await tx("samples", "readwrite", (s) => s.clear());
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
    voiceSamples: false,
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
  async function saveSettings(s) {
    const { learnedNames, voices, ...own } = s;
    await chrome.storage.local.set({ settings: own });
  }
  var key = (id) => `meeting:${id}`;
  async function listMeetings() {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    const r = await chrome.storage.local.get(meetingIds.map(key));
    return meetingIds.map((id) => r[key(id)]).filter(Boolean);
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
  function errorDetail(text) {
    try {
      const j = JSON.parse(text);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      return (typeof e === "string" ? e : e?.message) || j.err_msg || j.message || j.detail || text;
    } catch {
      return text;
    }
  }
  async function ensureEmailSecret() {
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
  async function saveVoices(list) {
    await chrome.storage.local.set({ voices: list });
  }
  async function forgetAllVoices() {
    await chrome.storage.local.remove("voices");
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

  // src/local.js
  var OLLAMA_BASE = "http://localhost:11434/v1";
  var WHISPER_BASE = "http://localhost:8000/v1";
  function isLocalBase(base) {
    try {
      const h = new URL(base).hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
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
    const j = await res.json().catch(() => ({}));
    const models = (j.models || []).map((m) => ({ name: m.name, sizeGB: Math.round((m.size || 0) / 1e9 * 10) / 10 }));
    if (!models.length) return { ok: false, message: "Ollama is running but has no models yet. Install one, for example: ollama pull gemma3" };
    return { ok: true, models };
  }
  async function ollamaContext(model, base = OLLAMA_BASE, fetchFn = fetch) {
    try {
      const res = await fetchFn(`${origin(base)}/api/show`, { method: "POST", body: JSON.stringify({ model, name: model }), signal: AbortSignal.timeout(6e3) });
      if (!res.ok) return null;
      const j = await res.json();
      const set = Number((String(j.parameters || "").match(/num_ctx\s+(\d+)/) || [])[1]);
      const max = Object.entries(j.model_info || {}).find(([k]) => k.endsWith(".context_length"))?.[1];
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
  function untilPacificMidnight(now = Date.now()) {
    const today = dayKey(new Date(now));
    for (let t = now + 5 * 6e4; t < now + 26 * 36e5; t += 5 * 6e4) if (dayKey(new Date(t)) !== today) return t;
    return now + 6 * 36e5;
  }
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
  async function geminiFetchInner(url, init, settings) {
    const call = (key2) => fetch(url, { ...init, headers: { ...init.headers, "x-goog-api-key": key2 } });
    const res = await call(settings.geminiKey).catch((e) => {
      if (!settings.geminiKey2 || e.name === "AbortError") throw e;
      return null;
    });
    if (res?.ok || !settings.geminiKey2 || res && !FALLBACK_STATUS(res.status)) return res;
    return call(settings.geminiKey2);
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
    const fn = PROVIDERS[opts.settings.llmProvider];
    if (!fn) throw new Error(`Unknown LLM provider ${opts.settings.llmProvider}`);
    return fn(opts);
  }

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
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error(
        /<html|accounts\.google\.com|Sign in/i.test(raw) ? 'The relay asked for a Google sign-in. Redeploy the web app with "Who has access: Anyone".' : `Unexpected reply from the mail relay (HTTP ${res.status}).`
      );
    }
    if (!j.ok) throw new Error(j.error || "The mail relay refused the request.");
    return j;
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
    const q = (x) => `'${String(x).replace(/'/g, "'")}'`;
    const list = parseAddresses(addresses.join(","));
    if (domains) {
      const ds = [...new Set(list.map((a) => a.split("@")[1].toLowerCase()))];
      return { allowed: "[]", domains: `[${ds.map(q).join(", ")}]` };
    }
    return { allowed: `[${list.map(q).join(", ")}]`, domains: "[]" };
  }
  function scriptWithAllowList(scriptText, addresses, opts) {
    const { allowed, domains } = allowListLines(addresses, opts);
    return scriptText.replace(/const ALLOWED = \[[^\]]*\];/, `const ALLOWED = ${allowed};`).replace(/const ALLOWED_DOMAINS = \[[^\]]*\];/, `const ALLOWED_DOMAINS = ${domains};`);
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
// Security: "Anyone" can reach the URL, so the script locks itself to the Debrief install that talks to it
// first. Debrief makes up a long random secret on its own (you never type it) and sends it with every
// request; the script remembers the first one and refuses everything else. Mail only ever goes to YOUR
// address plus the people you list below. If you reinstall Debrief or use a new browser profile and see
// "locked", run the function "resetSecret" here once and send a test email again.

const ALLOWED = []; // people you want to be able to share minutes with, e.g. ['priya@company.com']
const ALLOWED_DOMAINS = []; // or everyone at a company, e.g. ['company.com']

function doGet() {
  return out({ ok: true, message: 'Debrief mail relay is live.', version: 7, locked: !!PropertiesService.getScriptProperties().getProperty('secret') });
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

// First secret seen is kept (trust on first use). Everything after must present the same one.
function authorized(d) {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('secret');
  const given = typeof d.secret === 'string' ? d.secret : '';
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
    if (!authorized(d)) return out({ ok: false, error: 'This script is locked to a different Debrief install. In the script editor run the function resetSecret once, then try again.' });
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
  var oneLine = (x) => String(x || "").replace(/[\r\n,|]+/g, " ").replace(/\s+/g, " ").trim();
  function learnAlias(text, right, wrong) {
    const r = oneLine(right);
    const w = oneLine(wrong);
    if (!r) return String(text || "");
    const lines = String(text || "").split(/\r?\n/);
    const at = lines.findIndex((l) => {
      const t = l.trim();
      return t && !t.startsWith("#") && norm(t.split("|")[0]) === norm(r);
    });
    if (at < 0) {
      const add = w && norm(w) !== norm(r) ? `${r} | ${w}` : r;
      return [...lines.filter((l, i) => !(i === lines.length - 1 && !l.trim())), add].join("\n");
    }
    const [name, rest = ""] = lines[at].split("|");
    const aliases = rest.split(",").map((a) => a.trim()).filter(Boolean);
    if (w && norm(w) !== norm(r) && !aliases.some((a) => norm(a) === norm(w))) aliases.push(w);
    lines[at] = aliases.length ? `${name.trim()} | ${aliases.join(", ")}` : name.trim();
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
  var BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
  var LEGACY = { auto: ["en", "hi", "ml"], hinglish: ["hi", "en"], malayalam: ["ml", "en"] };
  function chosenLanguages(settings) {
    const list = settings?.meetingLanguages;
    if (Array.isArray(list) && list.length) return list.map((c) => BY_CODE.get(c)).filter(Boolean);
    const legacy = settings?.meetingLanguage;
    return legacy && legacy !== "auto" && LEGACY[legacy] ? LEGACY[legacy].map((c) => BY_CODE.get(c)) : null;
  }
  var minutesLanguageOptions = () => [...LANGUAGES.map((l) => ({ value: l.code === "hi" ? "Hindi (Devanagari)" : l.name, label: l.code === "hi" ? "Hindi (Devanagari)" : l.name })), { value: "the same language mix used in the meeting", label: "Same as the meeting" }];
  var names = (langs) => langs.length <= 1 ? langs[0]?.name || "" : `${langs.slice(0, -1).map((l) => l.name).join(", ")} and ${langs.at(-1).name}`;

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
    let clusters = vecs.map((_, i) => ({ members: [i] }));
    const sim = (a, b) => {
      let s = 0;
      for (const i of a.members) for (const j of b.members) s += cosine(vecs[i], vecs[j]);
      return s / (a.members.length * b.members.length);
    };
    for (; ; ) {
      let best = -1;
      let pair = null;
      for (let i2 = 0; i2 < clusters.length; i2++) {
        for (let j2 = i2 + 1; j2 < clusters.length; j2++) {
          const s = sim(clusters[i2], clusters[j2]);
          if (s > best) [best, pair] = [s, [i2, j2]];
        }
      }
      if (!pair || best < 1 - threshold) break;
      const [i, j] = pair;
      clusters[i] = { members: [...clusters[i].members, ...clusters[j].members] };
      clusters.splice(j, 1);
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
  var scale = (v, k) => Float32Array.from(v, (x) => x * k);
  var isAnon = (p) => /^Unnamed voice \d+$/.test(p?.name || "");
  var blockEntry = (p) => ({ name: p.name, centroid: p.centroid });
  function mergePeople(list, fromId, intoId) {
    const from = list.find((p) => p.id === fromId);
    const into = list.find((p) => p.id === intoId);
    if (!from || !into || from.id === into.id) throw new Error("Pick two different voices to merge.");
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
  var usableVoices = (people2) => (people2 || []).filter((p) => !p.auto || p.ready);
  function unnamedGroups(meeting, people2, { max = 4, minSecs = 15, cap = 300 } = {}) {
    const usable2 = usableVoices(people2);
    const segs = (meeting.voiceSegs || []).filter((s) => !usable2.length || !classify(unpack(s.e), usable2).id);
    if (segs.length < 4) return [];
    const step = Math.max(1, Math.ceil(segs.length / cap));
    const sample = segs.filter((_, i) => i % step === 0);
    return clusterVoices(sample).filter((g) => g.seconds * step >= minSecs).slice(0, max).map((g) => ({ seconds: Math.round(g.seconds * step), pieces: g.members.length, centroid: g.centroid, windows: g.members.filter((_, k) => k % Math.max(1, Math.floor(g.members.length / 8)) === 0).slice(0, 8).map((i) => sample[i].e), at: g.members.slice(0, 3).map((i) => Math.round(sample[i].t0)) }));
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
  var SR = 16e3;
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
      const target = [...this.recent].sort((x, y) => x - y)[Math.floor((this.recent.length - 1) * 0.2)];
      this.floor = this.recent.length === 1 ? db : Math.min(target, this.floor + 0.3);
      const speech = db > Math.max(this.floor + 9, -52);
      const at = this.samples;
      this.samples += block.length;
      if (speech) {
        if (!this.cur.length) this.curStart = at;
        this.cur.push(block);
        this.speechBlocks++;
        this.quiet = 0;
      } else if (this.cur.length) {
        this.quiet++;
        this.cur.push(block);
        if (this.quiet >= PAUSE_BLOCKS) this.close(true);
      }
      if (this.cur.length && (this.samples - this.curStart) / SR >= MAX_SEC) this.close(false);
    }
    close(trimQuiet) {
      const blocks = trimQuiet ? this.cur.slice(0, this.cur.length - this.quiet) : this.cur;
      const speech = this.speechBlocks;
      this.cur = [];
      this.quiet = 0;
      this.speechBlocks = 0;
      const len = blocks.reduce((a, b) => a + b.length, 0);
      if (len / SR < MIN_SEC || speech * (blocks[0]?.length || 2048) / len < 0.6) return;
      const pcm2 = new Float32Array(len);
      let o = 0;
      for (const b of blocks) {
        pcm2.set(b, o);
        o += b.length;
      }
      this.onSegment({ t0: this.curStart / SR, t1: this.curStart / SR + len / SR, pcm: pcm2 });
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
    const windows = keep.filter((_, i) => i % step === 0).slice(0, ENROL.maxWindows);
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
      const langs = Array.isArray(p.langs) ? p.langs.filter((l) => typeof l === "string").map((l) => l.slice(0, 8)).slice(0, 6) : [];
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
      const i = next.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
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
      const h = document.createElement("div");
      h.style.cssText = "white-space:pre-wrap;line-height:1.6;font-size:14.5px;color:var(--text)";
      h.textContent = [title, text].filter(Boolean).join("\n\n");
      dlg.append(h);
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

  // src/voices-ui.js
  var OKBTN = [{ label: "OK", value: "ok", primary: true }];
  var tell = (text) => modal({ text, buttons: OKBTN });
  var $ = (id) => document.getElementById(id);
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
    $("enrolMsg").textContent = t;
    $("enrolMsg").className = `msgbox ${kind === true ? "bad" : kind || ""}`.trim();
  };
  var READY_MSG = "Type a name, then press Record and read the text above. Use the mic you use in meetings.";
  var clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  var saving = false;
  function syncEnrol() {
    $("enrolRec").hidden = !!rec;
    $("enrolStop").hidden = !rec;
    $("enrolDot").hidden = !rec;
    $("enrolPlay").disabled = !pcm;
    $("enrolSave").disabled = !pcm || saving;
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
    const btns = items.map(({ label, fn, danger, aria }) => {
      const b = el("button", { type: "button", className: danger ? "danger" : "", textContent: label });
      b.setAttribute("role", "menuitem");
      if (aria) b.setAttribute("aria-label", aria);
      b.onclick = () => {
        closeMenu(true);
        fn();
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
    $("voiceEmpty").hidden = people.length > 0;
    $("hPeople").textContent = people.length ? `Enrolled people \xB7 ${people.length}` : "Enrolled people";
    $("voiceList").replaceChildren(
      ...people.map((p) => {
        const anon = p.auto && isAnon(p);
        const [badge, cls] = badgeOf(p);
        const langs = (p.langs || [p.lang || "en"]).map((l) => LANG_NAME[l] || l).join(" + ");
        const n = p.meetings || 1;
        const meta = p.auto ? `${anon ? "Heard in your meetings, not named yet" : "Learned from your meetings"} \xB7 ${n} meeting${n === 1 ? "" : "s"} \xB7 ${p.secs || 0} s of clean speech${p.ready ? "" : ` \xB7 not used yet, needs ${LEARN.readySecs} s from ${LEARN.readyMeetings} meetings`}` : `${langs} \xB7 ${p.secs || "?"} s of speech \xB7 added ${fmtDate(p.created)}`;
        const row = el("li", { className: "voice-row" });
        const initial = anon ? "?" : (Array.from(p.name.trim())[0] || "?").toUpperCase();
        const avatar = el("span", { className: `avatar${anon ? " anon" : ""}`, textContent: initial });
        avatar.setAttribute("aria-hidden", "true");
        const who = el("div", { className: "vwho" }, el("div", { className: "vtop" }, el("strong", { className: "vn", textContent: p.name }), el("span", { className: `chip ${cls}`.trim(), textContent: badge })), el("p", { className: "hint vm", textContent: meta }));
        const btn = (label, fn) => el("button", { type: "button", className: "btn sm", textContent: label, onclick: fn });
        const items = [{ label: "Export this voice", fn: () => download(exportVoices(people, [p.id]), `debrief-voice-${p.name.replace(/[^\w-]+/g, "_")}.json`) }];
        if (p.auto && people.length > 1) items.push({ label: "Merge into\u2026", fn: () => mergeInto(p) });
        items.push({ label: "Delete", aria: `Delete ${p.name}`, fn: () => remove(p), danger: true });
        const acts = el("div", { className: "vacts" }, ...anon ? [sampleButton(p)] : [], btn(anon ? "Name this voice" : "Rename", () => rename(p)), ...anon ? [] : [btn("Re-record", () => begin({ kind: "rerecord", id: p.id }, p)), btn("Add recording", () => begin({ kind: "add", id: p.id }, p))], ...moreMenu(p, items));
        row.append(avatar, who, acts);
        return row;
      })
    );
  }
  var playing = null;
  function sampleButton(p) {
    const b = el("button", { type: "button", className: "btn sm primary", hidden: true }, el("span", { className: "tri" }), "Play sample");
    b.setAttribute("aria-label", `Play sample of ${p.name}`);
    hasSample(p.id).then((yes) => b.hidden = !yes).catch(() => {
    });
    b.onclick = async () => {
      try {
        playing?.pause();
        const blob = await getSample(p.id);
        if (!blob) return b.hidden = true;
        const url = URL.createObjectURL(blob);
        playing = new Audio(url);
        playing.onended = () => URL.revokeObjectURL(url);
        await playing.play();
      } catch {
      }
    };
    return b;
  }
  async function refresh() {
    people = await getVoices();
    renderList();
    renderUnnamed().catch(() => {
    });
  }
  async function renderUnnamed() {
    const meetings = (await listMeetings()).filter((m2) => (m2.voiceSegs || []).length >= 20).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const m = meetings[0];
    const groups = m ? unnamedGroups(m, people) : [];
    $("unnamedCard").hidden = !groups.length;
    if (m) $("unnamedSub").textContent = `${m.title || "Your latest meeting"}${m.startedAt ? ` \xB7 ${fmtDate(m.startedAt)}` : ""}. Name a voice once and it is recognised next time.`;
    $("unnamedList").replaceChildren(
      ...groups.map((g, i) => {
        const label = el("label", { className: "sr-only", htmlFor: `unnamedName${i}`, textContent: `Name for Voice ${i + 1}` });
        const input = el("input", { id: `unnamedName${i}`, placeholder: "Who is this?", maxLength: 60, autocomplete: "off" });
        const save3 = el("button", { type: "button", className: "btn primary", textContent: "Name this voice" });
        const doSave = async () => {
          try {
            people = upsertPerson(people, { name: input.value, lang: "free", print: { centroid: g.centroid, windows: g.windows, speechSec: g.seconds } });
            await saveVoices(people);
            renderList();
            renderUnnamed();
          } catch (e) {
            tell(e.message);
          }
        };
        save3.onclick = doSave;
        input.onkeydown = (e) => e.key === "Enter" && doSave();
        return el(
          "li",
          {},
          el("div", { className: "ut" }, el("strong", { textContent: `Voice ${i + 1}` }), el("span", { className: "hint", textContent: `spoke ${g.seconds} s` })),
          el("p", { className: "hint", textContent: `For example at ${g.at.map(fmtTime).join(", ")}` }),
          el("div", { className: "name-row" }, label, input, save3)
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
      if (people.some((x) => x.id !== p.id && x.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already a voice called ${clean}.`);
      people = people.map((x) => x.id === p.id ? { ...x, name: clean } : x);
      await saveVoices(people);
      deleteSample(p.id).catch(() => {
      });
      renderList();
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
      people = people.filter((x) => x.id !== p.id);
      await saveVoices(people);
      deleteSample(p.id).catch(() => {
      });
      renderList();
    } catch (e) {
      tell(`Could not delete: ${e.message}`);
    }
  }
  async function mergeInto(p) {
    const others = people.filter((x) => x.id !== p.id);
    const r = await modal({ text: `Merge ${p.name} into which voice? The result keeps that voice's name.`, select: others.map((x) => ({ value: x.id, label: x.name })), buttons: [{ label: "Cancel", value: "no" }, { label: "Merge", value: "ok", primary: true }] });
    if (!r || r.value !== "ok") return;
    try {
      people = mergePeople(people, p.id, r.select);
      await saveVoices(people);
      deleteSample(p.id).catch(() => {
      });
      renderList();
    } catch (e) {
      tell(e.message);
    }
  }
  async function renderBlocked() {
    const blocked = await getBlockedVoices();
    $("voiceBlockedRow").hidden = !blocked.length;
    $("voiceBlockedMsg").textContent = `${blocked.length} learned voice${blocked.length === 1 ? " is" : "s are"} set never to be learned again.`;
  }
  function resetRecording() {
    stopCapture(true);
    pcm = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = "";
    $("enrolRec").textContent = "Record";
    $("enrolLevel").style.width = "0";
    $("enrolTime").textContent = "";
    syncEnrol();
  }
  function blankForm() {
    mode = { kind: "new", id: null };
    resetRecording();
    $("enrolName").value = "";
    $("enrolName").disabled = false;
    $("enrolTitle").textContent = "Add a person";
  }
  function begin(m, person) {
    resetRecording();
    mode = m;
    $("enrolTitle").textContent = m.kind === "new" ? "Add a person" : m.kind === "rerecord" ? `Re-record ${person.name}` : `Add another recording for ${person.name}`;
    $("enrolName").value = person ? person.name : "";
    $("enrolName").disabled = !!person;
    setLang(m.kind === "add" ? ORDER.find((l) => !(person.langs || [person.lang || "en"]).includes(l)) || "free" : lang);
    setMsg(m.kind === "add" ? "Record in another language this person uses in meetings: it makes the voice recognisable in each." : READY_MSG, m.kind === "add" ? "info" : "");
    (person ? $("enrolRec") : $("enrolName")).scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
    (person ? $("enrolRec") : $("enrolName")).focus({ preventScroll: true });
  }
  var reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function setLang(l) {
    lang = l;
    $("enrolPrompt").textContent = PROMPTS[l];
    $("enrolPrompt").lang = l === "free" ? "en" : l;
    document.querySelectorAll("#enrolLang button").forEach((b) => {
      const on = b.dataset.lang === l;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  async function startCapture() {
    if (rec) return;
    setMsg("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const ctx = new AudioContext({ sampleRate: SR });
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
      $("enrolLevel").style.width = `${Math.max(0, Math.min(100, (db + 50) / 40 * 100))}%`;
    };
    r.timer = setInterval(() => {
      const sec = (Date.now() - r.started) / 1e3;
      $("enrolTime").textContent = `${clock(sec)}${sec < ENROL.targetSec ? "" : " \u2713"}`;
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
    $("enrolRec").textContent = "Record again";
    $("enrolLevel").style.width = "0";
    syncEnrol();
    if (!got || got.pcm.length < SR * 3) {
      setMsg("That was too short. Press Record and read the text above.", "warn");
      return;
    }
    if (got.peak < 5e-3) {
      setMsg("Almost nothing was picked up. Check that the right microphone is selected in Chrome, then record again.", "bad");
      return;
    }
    pcm = got.pcm;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(new Blob([encodeWav(pcm, SR)], { type: "audio/wav" }));
    $("enrolTime").textContent = clock(pcm.length / SR);
    syncEnrol();
    setMsg("Play it back to check it is clear, then save. Nothing is stored until you press Save voice.", "ok");
  }
  async function save() {
    if (!pcm) return;
    const name = $("enrolName").value;
    try {
      if (mode.kind === "new") upsertPerson(people, { name, lang, print: { centroid: "", windows: [], speechSec: 0 } });
      saving = true;
      syncEnrol();
      setMsg("Working out the voice fingerprint\u2026 (the first time this loads the speaker model)", "info");
      const c = getClient();
      await Promise.race([c.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("The speaker model did not load. Reload this page and try again.")), 6e4))]);
      const print = await buildPrint(pcm, (p) => c.embed(p));
      if (!print.ok) {
        setMsg(print.reason, "warn");
        return;
      }
      if (mode.kind === "new") people = upsertPerson(people, { name, lang, print });
      else if (mode.kind === "rerecord") people = upsertPerson(people, { id: mode.id, name, lang, print });
      else people = addRecording(people, mode.id, { lang, print });
      await saveVoices(people);
      const done = `Saved ${name.trim()}: ${print.pieces} pieces of speech, ${print.speechSec.toFixed(0)} s. Only the fingerprint was stored.${print.warn ? ` ${print.warn}` : ""}`;
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
    const out = $("voiceShareMsg");
    try {
      if (file.size > 2e6) throw new Error("That file is too large to be a voices file.");
      const { people: incoming, problems } = parseImport(await file.text());
      if (!incoming.length) {
        out.textContent = problems[0] || "Nothing to import.";
        return;
      }
      const clash = incoming.filter((p) => people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())).map((p) => p.name);
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
    $("enrolJump").onclick = () => {
      $("enrol").scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
      $("enrolName").focus({ preventScroll: true });
    };
    setMsg(READY_MSG);
    syncEnrol();
    $("enrolRec").onclick = async () => {
      try {
        if (pcm) pcm = null;
        syncEnrol();
        if (mode.kind === "new" && !$("enrolName").value.trim()) {
          setMsg("Type the person\u2019s name first.", "bad");
          $("enrolName").focus();
          return;
        }
        await startCapture();
        $("enrolStop").focus();
        setMsg("Listening\u2026 keep going until about 20 seconds.", "info");
      } catch (e) {
        setMsg(e.name === "NotAllowedError" ? "The microphone is blocked. Use \u201CAllow microphone\u201D on the General page, then try again." : e.name === "NotFoundError" ? "No microphone is available. Allow it in General, under Microphone, or plug one in." : `Could not start the microphone: ${e.message}`, "bad");
      }
    };
    $("enrolStop").onclick = () => {
      finishCapture();
      $("enrolPlay").disabled ? $("enrolRec").focus() : $("enrolPlay").focus();
    };
    $("enrolPlay").onclick = () => audioUrl && new Audio(audioUrl).play();
    $("enrolSave").onclick = save;
    $("enrolCancel").onclick = () => {
      blankForm();
      setMsg(READY_MSG);
    };
    $("voiceExport").onclick = () => people.length ? download(exportVoices(people), "debrief-voices.json") : $("voiceShareMsg").textContent = "Nobody is enrolled yet.";
    $("voiceImport").onclick = () => $("voiceImportFile").click();
    $("voiceImportFile").onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) importFile(f);
    };
    renderBlocked();
    $("voiceAllowAgain").onclick = async () => {
      await saveBlockedVoices([]);
      renderBlocked();
    };
    $("voiceForget").onclick = async () => {
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
  var OK = "\u2713";
  var WARN = "!";
  var BAD = "\u2717";
  async function runCheckup() {
    const rows = [];
    const add = (level, title, detail = "", go = "", fixText = "") => rows.push({ level, title, detail, go, fixText });
    const s = await getSettings();
    if (s.sttProvider === "gemini" || s.llmProvider === "gemini") {
      add(s.geminiKey ? OK : BAD, "Gemini key", s.geminiKey ? s.geminiKey2 ? "main and backup key are set" : "a key is set (no backup key)" : "missing: add it on the Get started page", "start", "Add key");
      try {
        const { usage, learnedLimits = {}, modelCooldown = {} } = await chrome.storage.local.get(["usage", "learnedLimits", "modelCooldown"]);
        const limits = { ...learnedLimits, ...parseLimits(s.usageLimits) };
        const today = summarize(usage, 1);
        const used = (m) => today.filter((x) => x.model === m).reduce((a, x) => a + x.req, 0);
        for (const m of [s.sttGeminiModel, s.geminiModel].filter(Boolean)) {
          const lim = limits[m];
          if (!lim) add(OK, `Quota today: ${m}`, `${used(m)} requests so far (limit not known yet)`);
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
        const j = await res.json();
        if (j?.ok) add(Number(j.version) >= 7 ? OK : WARN, "Email relay", `reachable, script version ${j.version}${j.locked ? ", locked to this Debrief" : ", not locked yet (send a test email)"}${Number(j.version) >= 7 ? "" : ". Attendance from the calendar needs version 7: copy the script again and deploy a new version"}`);
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
        const muteLines = dbg.filter((x) => /^Meet mic/.test(x));
        const silent = dbg.find((x) => /^mic: the raw microphone/.test(x));
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

  // src/options.js
  var $2 = (id) => document.getElementById(id);
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
  function secretValue(k) {
    const v = $2(k).value.trim();
    return v || (removed.has(k) ? "" : stored[k] || "");
  }
  function renderSecret(k) {
    const u = secretUi[k];
    if (!u) return;
    const input = $2(k);
    const has = !!stored[k] && !removed.has(k);
    const masked = has && !editing.has(k);
    u.mask.hidden = !masked;
    input.hidden = masked;
    u.replace.hidden = !masked;
    u.keep.hidden = !(has && editing.has(k) || removed.has(k));
    u.keep.textContent = removed.has(k) ? "Undo remove" : "Keep current";
    u.remove.hidden = !(has && editing.has(k));
    u.note.hidden = false;
    u.note.replaceChildren();
    if (masked) u.note.append(el2("span", { className: "chip ok", textContent: "Saved" }), "On this computer only. Never shown again.");
    else if (removed.has(k)) u.note.append("The key will be removed when you press Save changes.");
    else if (has) u.note.append("Type the new key. Leave it empty, or press Escape, to keep the current one.");
    else u.note.hidden = true;
  }
  function renderSecrets() {
    SECRETS.forEach(renderSecret);
  }
  function initSecrets() {
    for (const k of SECRETS) {
      const input = $2(k);
      if (!input) continue;
      const label = document.querySelector(`label[for="${k}"]`);
      if (label && !label.id) label.id = `${k}-lbl`;
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
      secretUi[k] = { mask, replace, keep, remove: remove2, note: note2 };
      replace.onclick = () => {
        editing.add(k);
        renderSecret(k);
        input.focus();
      };
      const revert = () => {
        removed.delete(k);
        editing.delete(k);
        input.value = "";
        renderSecret(k);
        replace.focus();
        updateDirty();
      };
      keep.onclick = revert;
      remove2.onclick = () => {
        removed.add(k);
        editing.add(k);
        input.value = "";
        renderSecret(k);
        keep.focus();
        updateDirty();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && stored[k] && !input.hidden) {
          e.preventDefault();
          revert();
        }
      });
    }
  }
  function clearSecret(k) {
    $2(k).value = "";
    if (stored[k]) {
      removed.add(k);
      editing.add(k);
    }
    renderSecret(k);
  }
  function read() {
    const s = {};
    for (const k of FIELDS2) {
      const f = $2(k);
      if (!f) continue;
      s[k] = SECRETS.includes(k) ? secretValue(k) : f.type === "checkbox" ? f.checked : f.value.trim();
    }
    s.shareMode = $2("shareAuto").checked ? "auto" : "review";
    s.meetingLanguages = [...document.querySelectorAll("#langChips input:checked")].map((c) => c.dataset.lang);
    return s;
  }
  function fill(s) {
    for (const k of FIELDS2) {
      const f = $2(k);
      if (!f) continue;
      if (SECRETS.includes(k)) {
        stored[k] = s[k] || "";
        f.value = "";
      } else if (f.type === "checkbox") f.checked = !!s[k];
      else f.value = s[k] ?? "";
    }
    removed.clear();
    editing.clear();
    $2("shareAuto").checked = s.shareMode === "auto";
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
      const sel = $2(box.dataset.segFor);
      const btns = [...box.querySelectorAll("button")];
      const sync = () => {
        btns.forEach((b) => {
          const on = b.dataset.v === sel.value;
          b.setAttribute("aria-checked", String(on));
          b.tabIndex = on ? 0 : -1;
        });
        if (sel.id === "minutesMode") $2("minutesModeNote").textContent = MODE_NOTE[sel.value] || "";
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
    $2("learnedNames").textContent = names2.length ? names2.slice(-60).join(", ") : "None yet. Names are learned from your meetings.";
    const pending = learned?.pending || [];
    $2("pendingEmpty").classList.toggle("hidden", pending.length > 0);
    $2("pendingList").replaceChildren(
      ...pending.map((p) => {
        const row = el2("div", { className: "prow" });
        const t = el2("span", { className: "who" }, el2("b", { textContent: p.suggest }), " was heard as ", el2("b", { textContent: p.found }));
        const meta = el2("span", { className: "hint", textContent: `${p.count}\xD7 \xB7 ${p.meeting || "a meeting"}` });
        const ok = el2("button", { type: "button", className: "btn sm primary", textContent: "Fix it from now on" });
        const no = el2("button", { type: "button", className: "btn sm", textContent: "Dismiss" });
        ok.onclick = async () => {
          $2("dictionary").value = learnAlias($2("dictionary").value, p.suggest, p.found);
          await save2();
          await chrome.storage.local.set({ learned: { ...learned, pending: pending.filter((x) => x.id !== p.id) } });
        };
        no.onclick = async () => chrome.storage.local.set({ learned: { ...learned, pending: pending.filter((x) => x.id !== p.id), rejected: [...learned.rejected || [], p.id] } });
        row.append(t, meta, ok, no);
        return row;
      })
    );
  }
  $2("clearLearned").onclick = async () => {
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
  var money = (usd) => usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2);
  async function renderUsage() {
    const { usage, learnedLimits = {} } = await chrome.storage.local.get(["usage", "learnedLimits"]);
    const settings = await getSettings();
    const typed = parseLimits($2("usageLimits").value || settings.usageLimits);
    const limits = { ...learnedLimits, ...typed };
    const rows = summarize(usage, usageDays);
    const prices = parsePrices($2("usagePrices").value || settings.usagePrices);
    const today = summarize(usage, 1);
    const table = $2("usageTable");
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
      [usageDays === 1 ? "Left today (estimate)" : "", ""]
    ].forEach(([h, cls]) => head.append(Object.assign(document.createElement("th"), { textContent: h, className: cls })));
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
      cell(paid2.usd == null ? "-" : r.fail && !r.tin && !r.tout ? "$0.00" : `${paid2.assumed ? "~" : ""}$${money(paid2.usd)}`, "num cost");
      const left = tr.insertCell();
      left.className = "usage-left";
      const limit = limits[r.model];
      if (usageDays === 1 && limit) {
        const used = today.filter((x) => x.model === r.model).reduce((a, x) => a + x.req, 0);
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
    $2("usageTotals").replaceChildren(
      el2("strong", { textContent: `Total ${RANGE[usageDays] || ""}`.trim() }),
      el2("span", { textContent: `${reqs} requests` }),
      el2("span", { textContent: `${Math.round(audio / 60)} min of audio transcribed` }),
      ...cost != null ? [el2("span", { textContent: `about $${cost.toFixed(2)} at your prices` })] : [],
      el2("span", { className: "paid", textContent: `if this were paid: about $${paid.usd.toFixed(2)}${paid.assumed ? " (Gemini Flash list prices assumed where you set none)" : ""}${paid.unknown ? `, ${paid.unknown} line(s) unpriced` : ""}` }),
      el2("span", { className: "hint", style: "margin-left:auto", textContent: `Quota day ${dayKey()} (Pacific)` })
    );
  }
  var rangeBtns = [...document.querySelectorAll("#usageRange button")];
  var pickRange = (b) => {
    usageDays = Number(b.dataset.days);
    rangeBtns.forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-selected", String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    });
    renderUsage();
  };
  rangeBtns.forEach((b) => {
    b.onclick = () => pickRange(b);
    b.tabIndex = b.classList.contains("active") ? 0 : -1;
  });
  arrowKeys(rangeBtns, pickRange);
  $2("usageReset").onclick = async () => {
    const r = await modal({ text: "Reset all usage counters? This only clears Debrief's own tally.", buttons: [{ label: "Cancel", value: "no" }, { label: "Reset counters", value: "yes", danger: true }] });
    if (r?.value !== "yes") return;
    await chrome.storage.local.remove(["usage", "learnedLimits"]);
    renderUsage();
  };
  $2("usageLimits").addEventListener("input", renderUsage);
  $2("usagePrices").addEventListener("input", renderUsage);
  chrome.storage.onChanged.addListener((c) => {
    if (c.usage || c.learnedLimits) renderUsage();
  });
  function showProviderFields() {
    document.querySelectorAll("[data-stt]").forEach((f) => f.classList.toggle("hidden", f.dataset.stt !== $2("sttProvider").value));
    document.querySelectorAll("[data-llm]").forEach((f) => f.classList.toggle("hidden", f.dataset.llm !== $2("llmProvider").value));
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
    $2("langChips").replaceChildren(
      ...LANGUAGES.map((l) => {
        const label = document.createElement("label");
        label.className = "pick";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.lang = l.code;
        cb.onchange = langHint;
        label.append(cb, l.name);
        return label;
      })
    );
    $2("momLanguage").replaceChildren(...minutesLanguageOptions().map((o) => Object.assign(document.createElement("option"), { value: o.value, textContent: o.label })));
  }
  function setLanguageCodes(codes) {
    const set = new Set(codes);
    document.querySelectorAll("#langChips input").forEach((c) => c.checked = set.has(c.dataset.lang));
    langHint();
  }
  function setLanguages(s) {
    setLanguageCodes((chosenLanguages(s) || []).map((l) => l.code));
  }
  function langHint() {
    const picked = LANGUAGES.filter((l) => document.querySelector(`#langChips input[data-lang="${l.code}"]`)?.checked);
    $2("langHint").textContent = picked.length ? `Debrief will expect ${names(picked)}, in any mix. Fewer choices give more accurate text.` : "Nothing selected: automatic (Hindi, English and Malayalam are expected, and others are detected). Pick the languages your meetings really use for better accuracy.";
  }
  var loaded = {};
  var ready = false;
  var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function save2() {
    const vals = read();
    const out = { ...await getSettings() };
    for (const k of Object.keys(vals)) if (!same(vals[k], loaded[k])) out[k] = vals[k];
    await requestOrigins(out);
    await saveSettings(out);
    loaded = vals;
    for (const k of SECRETS) if ($2(k)) stored[k] = vals[k];
    removed.clear();
    editing.clear();
    for (const k of SECRETS) if ($2(k)) $2(k).value = "";
    renderSecrets();
    updateDirty();
    return out;
  }
  var flash = null;
  var flashTimer = 0;
  var isDirty = () => {
    if (!ready) return false;
    const v = read();
    return Object.keys(v).some((k) => !same(v[k], loaded[k]));
  };
  function updateDirty() {
    const bar = $2("savebar");
    const dirty = isDirty();
    bar.classList.toggle("dirty", dirty && !flash);
    bar.classList.toggle("saved", flash?.kind === "saved");
    bar.classList.toggle("bad", flash?.kind === "bad");
    $2("undo").hidden = !dirty;
    $2("msg").textContent = flash ? flash.text : dirty ? "You have unsaved changes" : "All changes saved";
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
  $2("undo").onclick = () => {
    applyValues(loaded);
    updateDirty();
    $2("save").focus();
  };
  async function micStatus() {
    try {
      const p = await navigator.permissions.query({ name: "microphone" });
      $2("micStatus").textContent = p.state === "granted" ? "Microphone allowed \u2713" : `Microphone: ${p.state}`;
      $2("micStatus").classList.toggle("ok", p.state === "granted");
    } catch {
    }
  }
  $2("sttProvider").onchange = showProviderFields;
  $2("llmProvider").onchange = showProviderFields;
  $2("save").onclick = async () => {
    try {
      await save2();
      showFlash("saved", "Saved \u2713", 3e3);
      updateGuide();
    } catch (e) {
      showFlash("bad", e.message, 7e3);
    }
  };
  $2("grantMic").onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      $2("micStatus").textContent = `Not allowed: ${e.message}`;
      return;
    }
    micStatus();
    updateGuide();
  };
  $2("useOllama").onclick = () => {
    $2("llmProvider").value = "openai";
    showProviderFields();
    $2("oaBase").value = OLLAMA_BASE;
    clearSecret("oaKey");
    $2("localStatus").textContent = 'Set to Ollama (http://localhost:11434/v1). Press "Find my installed models" to pick one.';
    updateDirty();
  };
  $2("findOllama").onclick = async () => {
    $2("localStatus").textContent = "Looking for Ollama\u2026";
    const base = $2("oaBase").value.trim() || OLLAMA_BASE;
    const r = await listOllamaModels(base);
    if (!r.ok) {
      $2("ollamaPick").classList.add("hidden");
      $2("localStatus").textContent = r.message;
      return;
    }
    const sel = $2("ollamaModels");
    sel.replaceChildren(...r.models.map((m) => Object.assign(document.createElement("option"), { value: m.name, textContent: `${m.name}${m.sizeGB ? ` (${m.sizeGB} GB)` : ""}` })));
    if (r.models.some((m) => m.name === $2("oaModel").value)) sel.value = $2("oaModel").value;
    $2("ollamaPick").classList.remove("hidden");
    const pick = async () => {
      $2("oaBase").value = base;
      $2("oaModel").value = sel.value;
      updateDirty();
      const ctx = await ollamaContext(sel.value, base);
      $2("localStatus").textContent = `Using ${sel.value}. ${contextAdvice(ctx)}`;
    };
    sel.onchange = pick;
    await pick();
  };
  $2("useWhisper").onclick = () => {
    $2("sttProvider").value = "openai";
    showProviderFields();
    $2("sttBase").value = WHISPER_BASE;
    clearSecret("sttKey");
    $2("whisperStatus").textContent = "Set to http://localhost:8000/v1. Change the address if your server uses another port.";
    updateDirty();
  };
  $2("testWhisper").onclick = async () => {
    $2("whisperStatus").textContent = "Testing\u2026";
    const base = ($2("sttBase").value.trim() || WHISPER_BASE).replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(6e3) });
      $2("whisperStatus").textContent = res.ok ? "The server answered \u2713" : explain(null, res.status, "The server");
    } catch (e) {
      $2("whisperStatus").textContent = explain(e, 0, "the server");
    }
  };
  $2("testLlm").onclick = async () => {
    $2("llmStatus").textContent = "Testing\u2026";
    try {
      const settings = await save2();
      const ping = (s) => generate({ settings: s, system: "You are a connectivity test.", user: "Reply with exactly: OK", onText: () => {
      } });
      const runs = [["Main", { ...settings, geminiKey2: "" }]];
      if (settings.llmProvider === "gemini" && settings.geminiKey2) runs.push(["Backup", { ...settings, geminiKey: settings.geminiKey2, geminiKey2: "" }]);
      const results = [];
      for (const [label, s] of runs) {
        try {
          const text = await ping(s);
          results.push(`${label}: works \u2713 ("${text.trim().slice(0, 20)}")`);
        } catch (e) {
          results.push(`${label}: failed: ${e.message.slice(0, 150)}`);
        }
      }
      $2("llmStatus").textContent = results.join(" \xB7 ");
    } catch (e) {
      $2("llmStatus").textContent = `Failed: ${e.message}`;
    }
  };
  async function updateGuide() {
    const s = await getSettings();
    const mic = await navigator.permissions.query({ name: "microphone" }).then((p) => p.state === "granted").catch(() => false);
    const needsGemini = s.sttProvider === "gemini" || s.llmProvider === "gemini";
    const langs = (chosenLanguages(s) || []).map((l) => l.name).join(", ");
    const done = { g1: !!s.geminiKey || !needsGemini, g2: mic, g3: !!s.myName, g4: mailReady(s) };
    const text = {
      g1: done.g1 ? s.geminiKey ? "Gemini key saved" : "No Gemini key needed: you use other services" : "Add your Gemini key",
      g2: done.g2 ? "Microphone allowed" : "Allow your microphone",
      g3: done.g3 ? `Name and languages: ${s.myName} \xB7 ${langs || "automatic"}` : "Set your name and languages",
      g4: done.g4 ? "Email is set up" : "Email the minutes to yourself"
    };
    for (const [id, ok] of Object.entries(done)) {
      const row = $2(id);
      if (!row) continue;
      row.classList.toggle("done", ok);
      row.querySelector(".ic").textContent = ok ? "\u2713" : id.slice(1);
      row.querySelector("[data-text]").textContent = text[id];
      row.querySelector("[data-state]").textContent = ok ? "Done. " : "Not done. ";
      const opt = row.querySelector("[data-opt]");
      if (opt) opt.hidden = ok;
    }
    const n = Object.values(done).filter(Boolean).length;
    $2("startLede").textContent = n === 4 ? "Everything is set up. Debrief is ready to record your next meeting." : `Four things make Debrief work. ${["None", "One", "Two", "Three"][n]} ${n === 1 ? "is" : "are"} done.`;
  }
  $2("g1go").onclick = () => {
    showTab("start");
    const f = $2("geminiKey");
    (f.hidden ? secretUi.geminiKey.replace : f).focus();
  };
  function allAllowed() {
    return parseAddresses([$2("shareList").value, ...parseGroups($2("shareGroups").value).map((g) => g.list.join(","))].join(","));
  }
  function renderAllow() {
    const l = allowListLines(allAllowed(), { domains: $2("shareDomains").checked });
    $2("allowLines").textContent = `const ALLOWED = ${l.allowed};
const ALLOWED_DOMAINS = ${l.domains};`;
  }
  ["shareList", "shareGroups"].forEach((id) => $2(id).addEventListener("input", renderAllow));
  $2("shareDomains").addEventListener("change", renderAllow);
  $2("copyScriptAllow").onclick = async () => {
    await navigator.clipboard.writeText(scriptWithAllowList(Code_default, allAllowed(), { domains: $2("shareDomains").checked }));
    $2("copyAllowMsg").textContent = "Copied. Paste it over your script, save, then deploy a new version.";
    setTimeout(() => $2("copyAllowMsg").textContent = "", 6e3);
  };
  $2("scriptText").textContent = Code_default;
  $2("copyScript").onclick = async () => {
    await navigator.clipboard.writeText(Code_default);
    $2("copyMsg").textContent = "Copied \u2713";
    setTimeout(() => $2("copyMsg").textContent = "", 1500);
  };
  var LEVEL = { "\u2713": ["ok", "Working"], "!": ["warn", "Warning"], "\u2717": ["bad", "Not working"] };
  function renderChecks(rows) {
    $2("checkupOut").replaceChildren(
      ...rows.map((r) => {
        const [cls, sr] = LEVEL[r.level] || LEVEL["!"];
        const ic = el2("span", { className: `ic ${cls}`, textContent: r.level });
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
  $2("checkup").onclick = async () => {
    $2("checkup").disabled = true;
    $2("checkupMsg").textContent = "Checking\u2026";
    try {
      const rows = await runCheckup();
      const text = checkupText(rows);
      renderChecks(rows);
      $2("checkupOut").hidden = false;
      $2("checkupCopy").hidden = false;
      $2("checkup").textContent = "Check again";
      const bad = rows.filter((r) => r.level === "\u2717").length;
      const warn = rows.filter((r) => r.level === "!").length;
      const summary = bad ? `${bad} problem${bad === 1 ? "" : "s"}, ${warn} to look at` : warn ? `No problems, ${warn} to look at` : "All good";
      $2("checkupMsg").textContent = summary;
      $2("checkupCopy").onclick = async () => {
        await navigator.clipboard.writeText(text);
        $2("checkupMsg").textContent = `Copied \u2713 ${summary}`;
      };
    } catch (e) {
      $2("checkupMsg").textContent = `Could not check: ${e.message}`;
    } finally {
      $2("checkup").disabled = false;
    }
  };
  $2("testMail").onclick = async () => {
    $2("mailMsg").textContent = "Sending\u2026";
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
      $2("mailMsg").textContent = `Sent to ${r.to} \u2713 Check your inbox.`;
    } catch (e) {
      $2("mailMsg").textContent = `Failed: ${e.message}`;
    }
  };
  (async () => {
    const s = await getSettings();
    buildLanguageUi();
    initSecrets();
    initSegs();
    fill(s);
    setLanguages(s);
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
    for (const k of FIELDS2) {
      const f = $2(k);
      if (!f || !same(read()[k], loaded[k])) continue;
      if (SECRETS.includes(k)) {
        stored[k] = fresh[k] || "";
        renderSecret(k);
      } else if (f.type === "checkbox") f.checked = !!fresh[k];
      else f.value = fresh[k];
      loaded[k] = fresh[k];
    }
    $2("shareAuto").checked = fresh.shareMode === "auto";
    loaded.shareMode = fresh.shareMode;
    if (same(read().meetingLanguages, loaded.meetingLanguages)) {
      setLanguages(fresh);
      loaded.meetingLanguages = read().meetingLanguages;
    }
    syncSegs();
    updateDirty();
    updateGuide();
  });
})();
