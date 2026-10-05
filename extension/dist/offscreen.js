(() => {
  // src/gemini.js
  var FALLBACK_STATUS = (s) => s === 400 || s === 401 || s === 403 || s === 429 || s >= 500;
  async function geminiFetch(url, init, settings) {
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

  // src/store.js
  var DEFAULTS = {
    myName: "",
    captureMic: true,
    meetingLanguage: "auto",
    // auto | hinglish | malayalam
    miniWindow: true,
    // open the controller window when recording starts
    pillOnPage: false,
    // also show the pill inside the Meet page
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
  var LANGUAGES = {
    auto: {
      codes: null,
      hint: "It may mix Hindi, English and Malayalam: write Hindi in Devanagari, Malayalam in Malayalam script, and English words in English."
    },
    hinglish: {
      codes: ["hi-IN", "en-IN"],
      hint: "It mixes Hindi and English: write Hindi in Devanagari and English words in English."
    },
    malayalam: {
      codes: ["ml-IN", "en-IN"],
      hint: "It is in Malayalam, often mixed with English: write Malayalam in Malayalam script (\u0D2E\u0D32\u0D2F\u0D3E\u0D33\u0D02) and English words in English."
    }
  };
  var lang = (s) => LANGUAGES[s.meetingLanguage] || LANGUAGES.auto;
  async function sarvam(wav, s) {
    const fd = new FormData();
    fd.append("file", wav, "chunk.wav");
    fd.append("model", s.sarvamModel);
    fd.append("mode", s.sarvamMode);
    fd.append("language_code", s.sarvamLanguage !== "unknown" ? s.sarvamLanguage : s.meetingLanguage === "malayalam" ? "ml-IN" : "unknown");
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
    if (s.meetingLanguage === "malayalam") fd.append("language", "ml");
    const prompt = s.meetingLanguage === "malayalam" && s.sttPrompt === DEFAULT_STT_PROMPT ? "Malayalam office meeting. Malayalam in Malayalam script, English words in English." : s.sttPrompt;
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
          parts: [{ text: `Transcribe this meeting audio exactly as spoken. ${lang(s).hint} Output only the transcript text, with no commentary. If there is no intelligible speech, output nothing.` }, ...parts]
        }]
      });
    }
    return (j.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  }
  async function gemini(wav, s) {
    let first = "";
    let err;
    try {
      first = await geminiCall(wav, s, s.sttGeminiModel);
    } catch (e) {
      err = e;
    }
    if (first.trim() || !/transcribe/.test(s.sttGeminiModel)) {
      if (err) throw err;
      return first;
    }
    let lastErr = err;
    for (const m of modelChain(s.geminiModel)) {
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
  async function transcribe(wav, settings) {
    const fn = PROVIDERS[settings.sttProvider];
    if (!fn) throw new Error(`Unknown STT provider ${settings.sttProvider}`);
    let delay = 1500;
    for (let attempt = 0; ; attempt++) {
      try {
        const text = (await fn(wav, settings)).trim();
        return isLoopNoise(text) ? "" : text;
      } catch (e) {
        const retryable = !(e instanceof SttError) || e.status === 429 || e.status >= 500;
        if (!retryable || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, e.status === 429 ? Math.max(delay, 2e4) : delay));
        delay *= 2;
      }
    }
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
  var DB = "debrief";
  var STORE = "pending";
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true }).createIndex("meetingId", "meetingId");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function run(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  var savePending = (item) => run("readwrite", (s) => s.add({ ...item, savedAt: Date.now() }));

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
        if (text) chrome.runtime.sendMessage({ target: "bg", type: "segment", meetingId, seg: { t, src, text } });
      } catch (e) {
        let saved = false;
        try {
          await savePending({ meetingId, src, t, wav, error: e.message });
          saved = true;
        } catch {
        }
        const note = saved ? "audio kept, will retry after the meeting" : "audio could not be kept";
        chrome.runtime.sendMessage({ target: "bg", type: "stt-error", meetingId, error: `[${Math.round(t)}s ${src}] ${e.message} (${note})` });
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
    await tap(ctx, tabStream, (b) => rec?.chunkers.others.push(b));
    if (micStream) {
      rec.chunkers.me = new Chunker("me", onChunk, chunkSize(settings, onSkip));
      await tap(ctx, micStream, (b) => rec?.chunkers.me.push(rec.micOn ? b : new Float32Array(b.length)));
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
    const dbg = (note) => chrome.runtime.sendMessage({ target: "bg", type: "dbg", meetingId, note });
    const trk = (s) => s?.getAudioTracks().map((t) => `${t.readyState}${t.muted ? " MUTED" : ""}${t.enabled ? "" : " disabled"}`).join("|") || "none";
    dbg(`start: ctx=${ctx.state} play=${playCtx.state} tab=${trk(tabStream)} mic=${trk(micStream)}`);
    let n = 0;
    rec.dbgTimer = setInterval(() => {
      if (!rec) return;
      n++;
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
