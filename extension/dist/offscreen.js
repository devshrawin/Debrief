(() => {
  // src/usage.js
  function dayKey(date = /* @__PURE__ */ new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
  }
  function learnLimit(text) {
    const s = String(text || "");
    const limit = Number((s.match(/limit:\s*(\d+)/i) || [])[1]);
    const model = (s.match(/model:\s*([\w.-]+)/i) || [])[1];
    return limit && model ? { model, limit } : null;
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
  function nextQuotaReset(now = Date.now()) {
    const today = dayKey(new Date(now));
    for (let t = now + 6e4; t < now + 26 * 36e5; t += 6e4) if (dayKey(new Date(t)) !== today) return t;
    return now + 12 * 36e5;
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
  async function isCooling(model) {
    await loadCool();
    return coolingNow(model);
  }
  var coolingNow = (model, now = Date.now()) => (cool.get(model) || 0) > now;
  async function usable(models) {
    await loadCool();
    const ok = models.filter((m) => !coolingNow(m));
    return ok.length ? ok : models;
  }
  async function allExhausted(models, now = Date.now()) {
    await loadCool();
    return models.length > 0 && models.every((m) => (cool.get(m) || 0) > now + 5 * 6e4);
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
    const call = (key) => fetch(url, { ...init, headers: { ...init.headers, "x-goog-api-key": key } });
    const res = await call(settings.geminiKey).catch((e) => {
      if (!settings.geminiKey2 || e.name === "AbortError") throw e;
      return null;
    });
    if (res?.ok || !settings.geminiKey2 || res && !FALLBACK_STATUS(res.status)) return res;
    return call(settings.geminiKey2);
  }
  var GENERAL_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"];
  var modelChain = (primary) => [...new Set([primary, ...GENERAL_FALLBACKS].filter(Boolean))];

  // src/noise.js
  function isLoopNoise(text) {
    const words = (text || "").toLowerCase().split(/[\s,.;:!?।|-]+/).filter(Boolean);
    if (words.length < 12) return false;
    if (new Set(words).size / words.length < 0.2) return true;
    for (let n = 1; n <= 6; n++) {
      let covered = 0;
      for (let i = 0; i + 2 * n <= words.length; ) {
        let reps = 1;
        while (i + (reps + 1) * n <= words.length && words.slice(i, i + n).join(" ") === words.slice(i + reps * n, i + (reps + 1) * n).join(" ")) reps++;
        if (reps >= 4) {
          covered += reps * n;
          i += reps * n;
        } else i++;
      }
      if (covered / words.length > 0.6) return true;
    }
    return false;
  }

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
  var MAX_PIECES = 200;
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
  var toInt16 = (f32) => Int16Array.from(f32, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))));
  var pieceKey = (meetingId, t0) => `${meetingId}|${Math.round(t0 * 100)}`;
  var putPiece = (key, i16) => tx("pieces", "readwrite", (s) => s.put(i16, key));

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
    minutesFormat: "amnex",
    // amnex = official Amnex template (Print/PDF, Word, email); standard = Debrief's own layout
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
  function errorDetail(text) {
    try {
      const j = JSON.parse(text);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      return (typeof e === "string" ? e : e?.message) || j.err_msg || j.message || j.detail || text;
    } catch {
      return text;
    }
  }

  // src/dictionary.js
  var norm = (s) => String(s || "").toLowerCase().normalize("NFKC").trim();
  function parseDictionary(text) {
    const entries = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const [name, rest = ""] = line.split("|");
      const canonical = name.trim();
      if (!canonical) continue;
      const aliases = rest.split(",").map((a) => a.trim()).filter((a) => a && norm(a) !== norm(canonical));
      entries.push({ name: canonical, aliases });
    }
    return entries;
  }
  function hintTerms(entries, attendees = []) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const t of [...attendees || [], ...entries.map((e) => e.name)]) {
      const k = norm(t);
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(t.trim());
      }
    }
    return out;
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
  var languagesOf = (settings) => chosenLanguages(settings) || LEGACY.auto.map((c) => BY_CODE.get(c));
  var names = (langs) => langs.length <= 1 ? langs[0]?.name || "" : `${langs.slice(0, -1).map((l) => l.name).join(", ")} and ${langs.at(-1).name}`;
  function languageHint(langs) {
    if (!langs.length) return "";
    const scripts = langs.filter((l) => l.code !== "en").map((l) => `${l.name} in ${l.script}`);
    const mix = langs.length > 1 ? `It may mix ${names(langs)}` : `It is in ${langs[0].name}`;
    return `${mix}: write ${scripts.length ? scripts.join(", ") : "English"}${langs.some((l) => l.code === "en") && scripts.length ? " and English words in English" : ""}.`;
  }
  var geminiCodes = (langs) => langs?.length ? langs.map((l) => l.bcp) : null;
  function singleLanguage(langs) {
    const other = langs.filter((l) => l.code !== "en");
    return other.length === 1 ? other[0] : null;
  }
  var SARVAM_CODES = /* @__PURE__ */ new Set(["hi", "ml", "ta", "te", "kn", "mr", "bn", "gu", "pa", "or", "en"]);

  // src/stt.js
  var SttError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  };
  var DEFAULT_STT_PROMPT = DEFAULTS.sttPrompt;
  async function check(res, provider) {
    if (res.ok) return res.json();
    let detail = "";
    try {
      detail = errorDetail(await res.text()).slice(0, 300);
    } catch {
    }
    throw new SttError(`${provider} HTTP ${res.status}: ${detail}`, res.status);
  }
  var sttTerms = (s) => hintTerms(parseDictionary(s.dictionary), s.learnedNames || []).slice(0, 80);
  var audioSeconds = (wav) => Math.max(0, (wav.size - 44) / 32e3);
  var lang = (s) => ({ codes: geminiCodes(chosenLanguages(s)), hint: languageHint(languagesOf(s)) });
  async function sarvam(wav, s) {
    const fd = new FormData();
    fd.append("file", wav, "chunk.wav");
    fd.append("model", s.sarvamModel);
    fd.append("mode", s.sarvamMode);
    const only = singleLanguage(chosenLanguages(s) || []);
    fd.append("language_code", s.sarvamLanguage !== "unknown" ? s.sarvamLanguage : only && SARVAM_CODES.has(only.code) ? only.bcp : "unknown");
    const res = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": s.sarvamKey },
      body: fd
    });
    const j = await check(res, "Sarvam");
    return j.transcript || "";
  }
  async function deepgram(wav, s) {
    const q = new URLSearchParams({
      model: s.deepgramModel,
      language: "multi",
      // Hindi-English code-switching on nova-3
      smart_format: "true",
      punctuate: "true"
    });
    for (const t of sttTerms(s).slice(0, 50)) q.append("keyterm", t);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
      method: "POST",
      headers: { Authorization: `Token ${s.deepgramKey}`, "Content-Type": "audio/wav" },
      body: wav
    });
    const j = await check(res, "Deepgram");
    return j.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  }
  async function openaiCompat(wav, s) {
    const fd = new FormData();
    fd.append("file", wav, "chunk.wav");
    fd.append("model", s.sttModel);
    fd.append("response_format", "json");
    const chosen = chosenLanguages(s);
    const only = singleLanguage(chosen || []);
    if (only) fd.append("language", only.code);
    const base = chosen && s.sttPrompt === DEFAULT_STT_PROMPT ? `${names(chosen)} office meeting. ${languageHint(chosen)}` : s.sttPrompt;
    const prompt = [base, sttTerms(s).length ? `Names: ${sttTerms(s).join(", ")}.` : ""].filter(Boolean).join(" ");
    if (prompt) fd.append("prompt", prompt);
    const headers = s.sttKey ? { Authorization: `Bearer ${s.sttKey}` } : {};
    const res = await fetch(`${s.sttBase.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: fd
    });
    const j = await check(res, "Transcription");
    return j.text || "";
  }
  async function toBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(bin);
  }
  async function geminiCall(wav, s, model) {
    const parts = [{ inlineData: { mimeType: "audio/wav", data: await toBase64(wav) } }];
    const post = async (body) => {
      const res = await geminiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, s);
      return check(res, "Gemini");
    };
    let j;
    if (/transcribe/.test(model)) {
      const codes = lang(s).codes;
      const cfg = (withCodes) => ({ contents: [{ role: "user", parts }], generationConfig: { audioTranscriptionConfig: { mode: "SMART", ...withCodes && codes ? { languageCodes: codes } : {} } } });
      try {
        j = await post(cfg(true));
      } catch (e) {
        if (!(codes && e.status === 400 && /languageCodes|language_codes|Invalid JSON/i.test(e.message))) throw e;
        j = await post(cfg(false));
      }
    } else {
      j = await post({
        contents: [{
          role: "user",
          parts: [{ text: `Transcribe this meeting audio exactly as spoken. ${lang(s).hint} ${sttTerms(s).length ? `These names and terms may be spoken, spell them exactly like this: ${sttTerms(s).join(", ")}. ` : ""}Output only the transcript text, with no commentary. If there is no intelligible speech, output nothing.` }, ...parts]
        }]
      });
    }
    record({ provider: "gemini", model, kind: "stt", tin: j.usageMetadata?.promptTokenCount, tout: j.usageMetadata?.candidatesTokenCount, audioSec: audioSeconds(wav) });
    return (j.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  }
  async function gemini(wav, s) {
    let first = "";
    let err;
    try {
      if (!await isCooling(s.sttGeminiModel)) first = await geminiCall(wav, s, s.sttGeminiModel);
    } catch (e) {
      err = e;
    }
    if (first.trim() || !/transcribe/.test(s.sttGeminiModel)) {
      if (err) throw err;
      return first;
    }
    let lastErr = err;
    for (const m of await usable(modelChain(s.geminiModel))) {
      try {
        return await geminiCall(wav, s, m);
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return "";
  }
  var PROVIDERS = { gemini, sarvam, deepgram, openai: openaiCompat };
  var sttModelName = (s) => ({ sarvam: s.sarvamModel, deepgram: s.deepgramModel, openai: s.sttModel })[s.sttProvider];
  function stripTimestamps(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const stamp = /^[\[(]?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?[\])]?\s*[-–:]?\s*/;
    if (lines.length < 3 || lines.filter((l) => stamp.test(l)).length < lines.length * 0.6) return String(text || "");
    return lines.map((l) => l.replace(stamp, "")).filter(Boolean).join(" ");
  }
  async function transcribe(wav, settings) {
    const fn = PROVIDERS[settings.sttProvider];
    if (!fn) throw new Error(`Unknown STT provider ${settings.sttProvider}`);
    let delay = 1500;
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await fn(wav, settings);
        if (settings.sttProvider !== "gemini") record({ provider: settings.sttProvider, model: sttModelName(settings), kind: "stt", req: 1, audioSec: audioSeconds(wav) });
        const text = stripTimestamps(raw).trim();
        return isLoopNoise(text) ? "" : text;
      } catch (e) {
        if (settings.sttProvider !== "gemini") record({ provider: settings.sttProvider, model: sttModelName(settings), kind: "stt", req: 1, fail: true, rl: e.status === 429 });
        const retryable = !(e instanceof SttError) || e.status === 429 || e.status >= 500;
        if (!retryable || attempt >= 3) throw e;
        if (settings.sttProvider === "gemini" && e.status === 429 && await allExhausted([settings.sttGeminiModel, ...modelChain(settings.geminiModel)])) throw e;
        await new Promise((r) => setTimeout(r, e.status === 429 ? Math.max(delay, 2e4) : delay));
        delay *= 2;
      }
    }
  }

  // src/chunker.js
  var SR = 16e3;
  var PAUSE = 0.35 * SR;
  var QUIET_RMS = 6e-3;
  var SPEECH_RMS = 0.012;
  var rms = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };
  var Chunker = class {
    // Looks for a pause once a chunk reaches minSec; always cuts at maxSec.
    constructor(src, onChunk, { minSec = 18, maxSec = 28, onSkip } = {}) {
      this.onSkip = onSkip;
      this.levelPeak = 0;
      this.total = 0;
      this.maxEver = 0;
      this.src = src;
      this.minLen = minSec * SR;
      this.maxLen = maxSec * SR;
      this.onChunk = onChunk;
      this.blocks = [];
      this.len = 0;
      this.offset = 0;
      this.quiet = 0;
      this.loudest = 0;
    }
    push(block) {
      this.total += block.length;
      this.blocks.push(block);
      this.len += block.length;
      const r = rms(block);
      this.loudest = Math.max(this.loudest, r);
      this.levelPeak = Math.max(this.levelPeak, r);
      this.maxEver = Math.max(this.maxEver, r);
      this.quiet = r < QUIET_RMS ? this.quiet + block.length : 0;
      if (this.len >= this.minLen && this.quiet >= PAUSE || this.len >= this.maxLen) this.flush();
    }
    // Loudest block since the last call; drives the popup's live level meter.
    takeLevel() {
      const p = this.levelPeak;
      this.levelPeak = 0;
      return p;
    }
    flush() {
      if (!this.len) return;
      const pcm = new Float32Array(this.len);
      let o = 0;
      for (const b of this.blocks) {
        pcm.set(b, o);
        o += b.length;
      }
      const start2 = this.offset / SR;
      const loud = this.loudest;
      this.offset += this.len;
      this.blocks = [];
      this.len = 0;
      this.quiet = 0;
      this.loudest = 0;
      if (pcm.length < SR || loud < SPEECH_RMS) {
        if (pcm.length >= SR) this.onSkip?.(this.src, start2, loud);
        return;
      }
      this.onChunk(this.src, start2, pcm);
    }
  };

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
  var savePending = (item) => run("readwrite", (s) => s.add({ ...item, savedAt: Date.now() }));

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
      const pcm = new Float32Array(len);
      let o = 0;
      for (const b of blocks) {
        pcm.set(b, o);
        o += b.length;
      }
      this.onSegment({ t0: this.curStart / SR2, t1: this.curStart / SR2 + len / SR2, pcm });
    }
    flush() {
      if (this.cur.length) this.close(true);
    }
  };

  // src/voice/client.js
  function createVoiceClient({ workerUrl, modelUrl, wasmPaths, maxQueue = 24 }) {
    const worker = new Worker(workerUrl);
    const pending = /* @__PURE__ */ new Map();
    let nextId = 1;
    let ready;
    let readyFail;
    const readyP = new Promise((res, rej) => {
      ready = res;
      readyFail = rej;
    });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.ready) return ready();
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
      embed(pcm) {
        if (pending.size >= maxQueue) return Promise.resolve(null);
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, pcm }, [pcm.buffer]);
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

  // src/voice/match.js
  function pack(emb) {
    const bytes = new Int8Array(emb.length);
    for (let i = 0; i < emb.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(emb[i] * 127)));
    let bin = "";
    for (const b of new Uint8Array(bytes.buffer)) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // src/offscreen.js
  var CONCURRENCY = 3;
  var chunkSize = (s, onSkip) => ({ ...s.sttProvider === "gemini" ? { minSec: 100, maxSec: 150 } : { minSec: 18, maxSec: 28 }, onSkip });
  var rec = null;
  function makePool(limit) {
    let active = 0;
    const queue = [];
    const pending = /* @__PURE__ */ new Set();
    const next = () => {
      while (active < limit && queue.length) {
        const job = queue.shift();
        active++;
        const p = job().finally(() => {
          active--;
          pending.delete(p);
          next();
        });
        pending.add(p);
      }
    };
    return {
      add(job) {
        queue.push(job);
        next();
      },
      async drain() {
        while (queue.length || pending.size) await Promise.allSettled([...pending]);
      }
    };
  }
  async function tap(ctx, stream, onBlock) {
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-tap", { channelCount: 1, channelCountMode: "explicit" });
    node.port.onmessage = (e) => onBlock(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
  }
  async function startVoice(meetingId, keepAudio = false) {
    const client = createVoiceClient({
      workerUrl: chrome.runtime.getURL("dist/worker.js"),
      modelUrl: chrome.runtime.getURL("models/wespeaker_resnet34_lm.onnx"),
      wasmPaths: chrome.runtime.getURL("vendor/ort/")
    });
    await Promise.race([client.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("model load timed out")), 45e3))]);
    const out = [];
    const flush = () => {
      if (!out.length) return;
      chrome.runtime.sendMessage({ target: "bg", type: "voice-seg", meetingId, segs: out.splice(0) }).catch(() => {
      });
    };
    let kept = 0;
    const tracker = new VoiceTracker((seg) => {
      if (keepAudio && kept < MAX_PIECES && seg.t1 - seg.t0 >= 2) {
        kept++;
        putPiece(pieceKey(meetingId, seg.t0), toInt16(seg.pcm)).catch(() => {
        });
      }
      client.embed(seg.pcm).then((e) => e && out.push({ t0: Math.round(seg.t0 * 100) / 100, t1: Math.round(seg.t1 * 100) / 100, e: pack(e) })).catch(() => {
      });
    });
    const timer = setInterval(flush, 1e4);
    return { client, tracker, flush, timer };
  }
  async function start({ streamId, settings, meetingId }) {
    if (rec) throw new Error("Already recording");
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
    const playCtx = new AudioContext();
    playCtx.createMediaStreamSource(tabStream).connect(playCtx.destination);
    let micStream = null;
    let micError = null;
    if (settings.captureMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch (e) {
        micError = e.name === "NotAllowedError" ? "Microphone permission not granted (open Settings \u2192 Grant microphone)." : e.message;
      }
    }
    const ctx = new AudioContext({ sampleRate: SR });
    await Promise.all([ctx.resume(), playCtx.resume()]);
    if (ctx.state !== "running") throw new Error(`Audio context is ${ctx.state}, recording would capture nothing.`);
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("worklet.js"));
    const pool = makePool(CONCURRENCY);
    const onChunk = (src, t, pcm) => pool.add(async () => {
      const wav = encodeWav(pcm, SR);
      const t0 = Date.now();
      try {
        const text = await transcribe(wav, settings);
        chrome.runtime.sendMessage({ target: "bg", type: "dbg", meetingId, note: `chunk ${src} @${Math.round(t)}s ${Math.round(pcm.length / SR)}s -> ${text.length} chars in ${((Date.now() - t0) / 1e3).toFixed(1)}s` });
        if (text) chrome.runtime.sendMessage({ target: "bg", type: "segment", meetingId, seg: { t, src, text, dur: Math.round(pcm.length / SR * 10) / 10 } });
      } catch (e) {
        let saved = false;
        try {
          await savePending({ meetingId, src, t, wav, error: e.message });
          saved = true;
        } catch {
        }
        const note2 = saved ? "audio kept, will retry after the meeting" : "audio could not be kept";
        chrome.runtime.sendMessage({ target: "bg", type: "stt-error", meetingId, error: `[${Math.round(t)}s ${src}] ${e.message} (${note2})` });
      }
    });
    const onSkip = (src, t, peak) => chrome.runtime.sendMessage({
      target: "bg",
      type: "dbg",
      meetingId,
      note: `[${Math.round(t)}s ${src}] chunk skipped as silent (peak ${peak.toFixed(4)}, needs 0.012)`
    });
    rec = { tabStream, micStream, playCtx, ctx, pool, micOn: !!micStream, chunkers: {} };
    rec.chunkers.others = new Chunker("others", onChunk, chunkSize(settings, onSkip));
    await tap(ctx, tabStream, (b) => {
      rec?.chunkers.others.push(b);
      rec?.voice?.tracker.push(b);
    });
    if (micStream) {
      rec.chunkers.me = new Chunker("me", onChunk, chunkSize(settings, onSkip));
      await tap(ctx, micStream, (b) => {
        if (rec) {
          let pk = 0;
          for (let i = 0; i < b.length; i += 8) pk = Math.max(pk, Math.abs(b[i]));
          rec.micRawPeak = Math.max(rec.micRawPeak || 0, pk);
          rec.micRawBlocks = (rec.micRawBlocks || 0) + 1;
        }
        rec?.chunkers.me.push(rec.micOn ? b : new Float32Array(b.length));
      });
    }
    if (settings.voiceOn && (settings.voices || []).length || settings.voiceLearn) {
      rec.voice = await startVoice(meetingId, !!(settings.voiceLearn && settings.voiceSamples)).catch(() => null);
      chrome.runtime.sendMessage({ target: "bg", type: "dbg", meetingId, note: rec.voice ? "voice recognition: on" : "voice recognition: could not start (recording continues without it)" });
    }
    tabStream.getAudioTracks()[0].addEventListener("ended", () => chrome.runtime.sendMessage({ target: "bg", type: "stop" }));
    rec.levelTimer = setInterval(() => {
      if (!rec) return;
      chrome.runtime.sendMessage({
        target: "bg",
        type: "level",
        tab: rec.chunkers.others.takeLevel(),
        mic: rec.chunkers.me && rec.micOn ? rec.chunkers.me.takeLevel() : null,
        ctx: rec.ctx.state
      });
    }, 1e3);
    const dbg = (note2) => chrome.runtime.sendMessage({ target: "bg", type: "dbg", meetingId, note: note2 });
    const trk = (s) => s?.getAudioTracks().map((t) => `${t.readyState}${t.muted ? " MUTED" : ""}${t.enabled ? "" : " disabled"}`).join("|") || "none";
    dbg(`start: ctx=${ctx.state} play=${playCtx.state} tab=${trk(tabStream)} mic=${trk(micStream)}`);
    let n = 0;
    rec.dbgTimer = setInterval(() => {
      if (!rec) return;
      n++;
      if (rec.micStream && !rec.micWarned && rec.micRawBlocks > 400 && rec.micRawPeak < 5e-4) {
        rec.micWarned = true;
        dbg(`mic: the raw microphone signal has been silent for ${n * 5}s (peak ${rec.micRawPeak.toFixed(5)}): wrong device or blocked`);
        chrome.runtime.sendMessage({ target: "bg", type: "mic-silent", meetingId });
      }
      const c = rec.chunkers.others;
      dbg(`t+${n * 5}s ctx=${rec.ctx.state} play=${rec.playCtx.state} tab=${trk(rec.tabStream)} tabSamples=${c.total} tabPeak=${c.maxEver.toFixed(4)}` + (rec.chunkers.me ? ` micSamples=${rec.chunkers.me.total} micPeak=${rec.chunkers.me.maxEver.toFixed(4)}` : ""));
      if (n >= 24) clearInterval(rec.dbgTimer);
    }, 5e3);
    return { mic: !!micStream, micError };
  }
  async function stop() {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearInterval(r.levelTimer);
    clearInterval(r.dbgTimer);
    Object.values(r.chunkers).forEach((c) => c.flush());
    [r.tabStream, r.micStream].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
    await Promise.allSettled([r.ctx.close(), r.playCtx.close()]);
    await r.pool.drain();
    if (r.voice) {
      r.voice.tracker.flush();
      await r.voice.client.drain(2e4);
      clearInterval(r.voice.timer);
      r.voice.flush();
      r.voice.client.close();
    }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== "offscreen") return;
    if (msg.type === "start") {
      start(msg).then(
        (r) => sendResponse({ ok: true, ...r }),
        (e) => sendResponse({ ok: false, error: e.message })
      );
      return true;
    }
    if (msg.type === "stop") {
      stop().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "mic") {
      if (rec) rec.micOn = !!msg.on && !!rec.micStream;
      sendResponse({ ok: true, micOn: rec?.micOn ?? false });
    }
  });
})();
