(() => {
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
  function errorDetail(text) {
    try {
      const j = JSON.parse(text);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      return (typeof e === "string" ? e : e?.message) || j.err_msg || j.message || j.detail || text;
    } catch {
      return text;
    }
  }
  async function setSetting(patch2) {
    const { settings } = await chrome.storage.local.get("settings");
    const { learnedNames, voices, ...clean } = patch2;
    await chrome.storage.local.set({ settings: { ...settings || {}, ...clean } });
  }
  async function ensureEmailSecret() {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings?.emailSecret) return settings.emailSecret;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ settings: { ...settings || {}, emailSecret: secret } });
    return secret;
  }

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
    const call = (key) => fetch(url, { ...init, headers: { ...init.headers, "x-goog-api-key": key } });
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
      for (const p2 of ev.candidates?.[0]?.content?.parts || []) {
        if (p2.text && !p2.thought) {
          text += p2.text;
          onText(p2.text);
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

  // src/welcome.js
  var GUIDE = "https://github.com/devshrawin/Debrief/blob/pro/docs/SETUP.md";
  var LOCAL_GUIDE = "https://github.com/devshrawin/Debrief/blob/pro/docs/LOCAL.md";
  var S = { ...DEFAULTS };
  var tour = { step: 0, visited: [], keyOk: false };
  var micOk = false;
  var shortcuts = {};
  var $ = (id) => document.getElementById(id);
  function h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e[k] = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  var card = (title, ...kids) => h("div", { class: "card" }, title ? h("h2", {}, title) : null, ...kids);
  var p = (text, cls) => h("p", { class: cls || "" }, text);
  var kbd = (t) => h("kbd", {}, t);
  var status = () => h("span", { class: "status" });
  var say = (el, text, kind) => {
    el.textContent = text;
    el.className = `status ${kind || ""}`;
  };
  async function patch(obj) {
    S = { ...S, ...obj };
    const { shareAutoFlag, ...clean } = obj;
    await setSetting(clean);
  }
  async function saveTour() {
    await chrome.storage.local.set({ tour });
  }
  function toggle(key, title, sub, { invert = false, onChange } = {}) {
    const cb = h("input", { type: "checkbox" });
    cb.checked = invert ? !S[key] : !!S[key];
    cb.onchange = async () => {
      if (key === "shareAutoFlag") S.shareAutoFlag = cb.checked;
      else await patch({ [key]: invert ? !cb.checked : cb.checked });
      onChange?.(cb.checked);
    };
    return h("label", { class: "toggle" }, h("span", { class: "t" }, h("b", {}, title), h("span", {}, sub)), cb);
  }
  function field(label, id, value, { type = "text", placeholder = "", area = false } = {}) {
    const el = area ? h("textarea", { id, placeholder }) : h("input", { id, type, placeholder, autocomplete: "off" });
    el.value = value || "";
    return [h("label", { for: id }, label), el];
  }
  var STEPS = [
    {
      id: "welcome",
      label: "Welcome",
      kicker: "Welcome",
      title: "Meeting minutes without taking notes",
      lede: "This takes about five minutes. Every step can be skipped and redone later in Settings, and each one is tested so you know it works before your first real meeting.",
      nodes: () => [
        card(
          "How Debrief works",
          h(
            "ol",
            { class: "how" },
            h("li", {}, "You join your online meeting in Chrome as you always do: Google Meet, Zoom or Teams in the browser, Webex and others."),
            h("li", {}, "You start Debrief. It records the sound of that browser tab (the other people) and, if you want, your own microphone."),
            h("li", {}, "It turns the speech into text, in Hindi, English, Malayalam or any mix of them."),
            h("li", {}, "When the call ends, Debrief stops by itself, writes the minutes with decisions and action items, and can email them to you and your team.")
          )
        ),
        h(
          "div",
          { class: "grid2" },
          h("div", { class: "mini" }, h("b", {}, "What you need"), "One free Gemini key (two minutes). Everything else is optional: microphone, names, email, sharing."),
          h("div", { class: "mini" }, h("b", {}, "Your privacy"), "Debrief has no server of its own. Audio and text go from your browser to the services you choose, and your keys stay in this browser. If you turn on email, the minutes also pass through a script in your own Google account.")
        ),
        h("div", { class: "callout", style: "margin-top:16px" }, "Tell participants when you are recording. Your company may also restrict browser extensions or tab capture.")
      ]
    },
    {
      id: "key",
      label: "Gemini key",
      kicker: "Step 1",
      title: "Add your free Gemini key",
      lede: "Gemini turns the speech into text and writes the minutes. Google gives you a free key; no card is needed.",
      nodes: () => {
        const st = status();
        const test = h("button", { class: "btn primary", onclick: async () => {
          const key = $("t-key").value.trim();
          if (!key) return say(st, "Paste your key first.", "bad");
          say(st, "Testing\u2026");
          await patch({ geminiKey: key, geminiKey2: $("t-key2").value.trim() });
          try {
            const out = await generate({ settings: { ...S, llmProvider: "gemini" }, system: "You are a connectivity test.", user: "Reply with exactly: OK", onText: () => {
            } });
            tour.keyOk = true;
            await saveTour();
            say(st, `Your key works \u2713 (it answered "${out.trim().slice(0, 12)}")`, "ok");
          } catch (e) {
            say(st, `That did not work: ${e.message.slice(0, 160)}`, "bad");
          }
        } }, "Test my key");
        return [
          card(
            "Get a key (2 minutes)",
            h(
              "ol",
              { class: "how" },
              h("li", {}, "Open ", h("a", { href: "https://aistudio.google.com/apikey", target: "_blank" }, "aistudio.google.com/apikey"), " and sign in with a Google account."),
              h("li", {}, "Click ", h("b", {}, "Create API key"), " and copy it."),
              h("li", {}, "Paste it below and press ", h("b", {}, "Test my key"), ".")
            ),
            ...field("Gemini API key", "t-key", S.geminiKey, { type: "password", placeholder: "Paste your key here" }),
            h("div", { class: "btnrow" }, test, st)
          ),
          card(
            "Good to know",
            p("The free tier has daily limits per model, so very long or many meetings in one day can hit them. Debrief switches to other models automatically, keeps any audio it could not process, and shows a red alert if a limit stops it."),
            p("On the free tier Google may use what you send to improve its products and reviewers may read it. For confidential meetings, turn on billing for the key or pick another provider in Settings.", "hint"),
            ...field("Backup key (optional)", "t-key2", S.geminiKey2, { type: "password", placeholder: "A key from a different Google Cloud project" }),
            p("Limits count per project, so a backup only helps if it comes from a different project.", "hint")
          )
        ];
      },
      save: async () => patch({ geminiKey: $("t-key").value.trim(), geminiKey2: $("t-key2").value.trim() })
    },
    {
      id: "mic",
      label: "Microphone",
      kicker: "Step 2",
      title: "Your microphone",
      lede: "Debrief always records the other people from the tab. To include your own voice it also needs your microphone.",
      optional: true,
      nodes: () => {
        const st = status();
        if (micOk) say(st, "Microphone allowed \u2713", "ok");
        return [
          card(
            "Allow the microphone",
            p("Chrome asks once. Press the button and choose Allow."),
            h("div", { class: "btnrow" }, h("button", { class: "btn primary", onclick: async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((t) => t.stop());
                micOk = true;
                say(st, "Microphone allowed \u2713", "ok");
              } catch (e) {
                say(st, `Not allowed: ${e.message}. You can allow it later from the lock icon in the address bar or in Settings.`, "bad");
              }
            } }, "Allow microphone"), st)
          ),
          card(
            "How your voice is handled",
            toggle("captureMic", "Include my microphone", "Your own voice goes into the transcript, labelled with your name."),
            toggle("followMeetMute", "Pause my mic while muted in the meeting", "Muting yourself in the meeting app does not mute Debrief by itself, so this makes Debrief follow the app's mute button. Side conversations stay out of the transcript."),
            p("You can also switch your voice in or out at any time from the popup or with the keyboard.", "hint")
          )
        ];
      }
    },
    {
      id: "you",
      label: "You and language",
      kicker: "Step 3",
      title: "Your name and languages",
      lede: "Your name labels your lines in the transcript. The languages tune the speech recognition.",
      nodes: () => [
        card(
          "",
          ...field("Your name", "t-name", S.myName, { placeholder: "e.g. Shrawin Sisodiya" }),
          h("label", {}, "Languages spoken in your meetings (pick any number)"),
          h("div", { class: "chips", id: "t-langs" }, ...LANGUAGES.map((l) => h("label", { class: "chip" }, h("input", { type: "checkbox", "data-lang": l.code }), l.name))),
          p("Leave all unticked for automatic. Picking just the languages you really use makes the text more accurate.", "hint"),
          h("label", { for: "t-mom" }, "Language of the written minutes"),
          h("select", { id: "t-mom" }, ...minutesLanguageOptions().map((o) => h("option", { value: o.value }, o.label)))
        )
      ],
      after: () => {
        const chosen = new Set((chosenLanguages(S) || []).map((l) => l.code));
        document.querySelectorAll("#t-langs input").forEach((c) => c.checked = chosen.has(c.dataset.lang));
        $("t-mom").value = S.momLanguage;
      },
      save: async () => patch({ myName: $("t-name").value.trim(), meetingLanguages: [...document.querySelectorAll("#t-langs input:checked")].map((c) => c.dataset.lang), momLanguage: $("t-mom").value })
    },
    {
      id: "names",
      label: "Names and terms",
      kicker: "Step 4",
      title: "Teach Debrief your names",
      lede: 'Speech recognition guesses unusual names and local terms: "Amal" often comes out as "Aman". A short dictionary fixes this for good.',
      optional: true,
      nodes: () => [
        card(
          "Your dictionary",
          p("One entry per line. Write the correct spelling, then a bar, then the wrong versions Debrief tends to produce. A line with only a name or term is just a spelling hint."),
          ...field("", "t-dict", S.dictionary, { area: true, placeholder: "Amal | Aman, Amaal\nPriya Nair\nUnified Registry\nDSM" }),
          p("Used as a hint to the speech model, as an automatic correction of the transcript, and by the minutes writer.", "hint")
        ),
        card(
          "Two more tools you will meet later",
          h(
            "ol",
            { class: "how" },
            h("li", {}, h("b", {}, "Who was in the meeting"), ': on each minutes page you can list the attendees. Then "Aman" is corrected to "Amal" only if Amal is there and Aman is not.'),
            h("li", {}, h("b", {}, "Fix a name everywhere"), ": spot a wrong name in the minutes, type the wrong and right spelling once, and it is corrected in the transcript and minutes and remembered for next time.")
          )
        )
      ],
      save: async () => patch({ dictionary: $("t-dict").value })
    },
    {
      id: "record",
      label: "Recording",
      kicker: "Step 5",
      title: "Recording your first meeting",
      lede: "Here is exactly what to do in a meeting, and what Debrief does for you.",
      nodes: () => [
        card(
          "In the meeting",
          h(
            "ol",
            { class: "how" },
            h("li", {}, "Join your meeting in Chrome as usual (Google Meet, or Zoom, Teams and others in the browser) and keep that tab in front. The Debrief icon glows amber on the tab while a call is on, as a reminder to record."),
            h("li", {}, "Click the Debrief icon in the toolbar and press ", h("b", {}, "Start recording this tab"), ", or just press ", kbd(shortcuts["toggle-recording"] || "Alt+Shift+M"), ". The icon shows a red REC badge."),
            h("li", {}, "Open the popup any time to see two level bars: ", h("b", {}, "Meeting audio"), " should move when others speak, and ", h("b", {}, "Your mic"), ' when you do. If they say "silent", fix the sound before you have lost minutes.'),
            h("li", {}, "To leave your own voice out for a while, use the switch in the popup or press ", kbd(shortcuts["toggle-mic"] || "Alt+Shift+K"), "."),
            h("li", {}, "When the meeting ends, Debrief stops by itself, opens the minutes in a background tab, and writes them. This takes a minute or two. You can also press ", h("b", {}, "Stop & write MOM"), " yourself."),
            h("li", {}, 'On the minutes page, check names and numbers, list the attendees if you like, then copy, download or share them. Keep the tab open until it says "Emailed \u2713" if email is on.')
          )
        ),
        card(
          "Automatic behaviour",
          toggle("autoStop", "Stop when the meeting ends", 'Notices the "you left" or "meeting ended" screen, or you leaving the call page.'),
          h("label", { for: "t-quiet" }, "Also stop after silence"),
          h(
            "select",
            { id: "t-quiet", onchange: (e) => patch({ autoStopQuietMin: Number(e.target.value) }) },
            h("option", { value: "0" }, "Never"),
            h("option", { value: "5" }, "After 5 quiet minutes"),
            h("option", { value: "10" }, "After 10 quiet minutes"),
            h("option", { value: "15" }, "After 15 quiet minutes"),
            h("option", { value: "30" }, "After 30 quiet minutes")
          ),
          p("A safety net for when nobody has made a sound for that long.", "hint")
        ),
        card(
          "Optional extras on the meeting page",
          toggle("pillOnPage", "Show a small recording pill on the call", "A draggable capsule with the timer, a mic switch and alerts. Off by default so nothing covers your meeting."),
          h("label", { for: "t-cap" }, "Speaker names (Google Meet only)"),
          h(
            "select",
            { id: "t-cap", onchange: (e) => patch({ meetCaptions: e.target.value }) },
            h("option", { value: "read" }, "Use Meet's captions when I have them on"),
            h("option", { value: "auto" }, "Turn captions on for me while recording"),
            h("option", { value: "off" }, "Don't read captions")
          ),
          p("Meet's live captions say who is speaking, so the minutes can name people. Turning captions on shows subtitles on your screen.", "hint"),
          p('In the popup, "Check page detection" shows what Debrief can read from your meeting page. Use it once in a call to see that the mute button, speaker names and attendance are recognised.', "hint")
        )
      ],
      after: () => {
        $("t-quiet").value = String(S.autoStopQuietMin ?? 10);
        $("t-cap").value = S.meetCaptions || "read";
      }
    },
    {
      id: "voices",
      label: "Who is speaking",
      kicker: "Step 6",
      title: "Put names to voices",
      lede: 'Optional. Debrief can guess who is speaking from the sound of their voice, so the transcript and minutes can say "Priya" instead of "Others". It is a best guess and says "Unknown speaker" when unsure.',
      optional: true,
      nodes: () => [
        card(
          "How it works",
          h(
            "ul",
            { class: "how" },
            h("li", {}, "Everything happens in your browser. A small speaker model that ships with the extension (WeSpeaker ResNet34, 26 MB, CC-BY-4.0) turns short stretches of speech into a list of 256 numbers. Audio is never saved or sent anywhere for this."),
            h("li", {}, "You add people in ", h("b", {}, "Settings \u2192 Voices"), " by recording about 20 seconds of each person reading a short text, in the language they use in meetings (English, Hindi, Malayalam or free speech). Only the numbers are stored."),
            h("li", {}, "Overlapping speech, unfamiliar voices and noisy stretches show as ", h("b", {}, "Unknown speaker"), ", and where Meet's captions name someone else, both names are shown."),
            h("li", {}, "Accuracy depends on microphones and rooms. Check the names against what you remember before relying on them.")
          )
        ),
        card(
          "Turn it on",
          toggle("voiceOn", "Name speakers by their voice (best guess)", "Uses the voices you add in Settings. Off by default."),
          toggle("voiceLearn", "Learn voices on its own from my meetings", `Groups voices that keep coming back and lists them as "Unnamed voice" for you to rename once, in any language. Meet's captions help name them when available but are not needed. A learned voice is not used until it has been heard in two meetings. Tell your colleagues, and delete anyone any time.`),
          h("div", { class: "btnrow" }, h("a", { class: "btn", href: "options.html#voices", target: "_blank" }, "Open Voices settings")),
          p('You can skip this and set it up later: Settings \u2192 Voices. "Forget all voices" there deletes every fingerprint.', "hint")
        )
      ]
    },
    {
      id: "email",
      label: "Email the minutes",
      kicker: "Step 7",
      title: "Get the minutes by email",
      lede: "Optional, and worth the two minutes. The minutes arrive in your inbox as soon as they are written, sent from your own Google account through a small script you control. No Debrief server is involved.",
      optional: true,
      nodes: () => {
        const st = status();
        const copyMsg = status();
        return [
          card(
            "Set it up",
            h(
              "ol",
              { class: "how" },
              h(
                "li",
                {},
                "Press ",
                h("b", {}, "Copy the script"),
                " below.",
                h("div", { class: "btnrow" }, h("button", { class: "btn", onclick: async () => {
                  await navigator.clipboard.writeText(Code_default);
                  say(copyMsg, "Copied \u2713", "ok");
                } }, "Copy the script"), copyMsg)
              ),
              h("li", {}, "Open ", h("a", { href: "https://script.google.com/home/start", target: "_blank" }, "script.google.com"), ", click ", h("b", {}, "New project"), ", click in the code box, press ", kbd("Ctrl+A"), " then ", kbd("Ctrl+V"), " to replace everything, and save with ", kbd("Ctrl+S"), "."),
              h("li", {}, "In the toolbar choose the function ", h("b", {}, "authorize"), " and press ", h("b", {}, "Run"), ". Allow access when Google asks (click ", h("i", {}, "Advanced \u2192 Go to \u2026 (unsafe)"), " if it warns, it is your own script)."),
              h("li", {}, "Click ", h("b", {}, "Deploy \u2192 New deployment"), ", choose ", h("b", {}, "Web app"), ", set ", h("b", {}, "Who has access"), " to ", h("b", {}, "Anyone"), ", and click ", h("b", {}, "Deploy"), "."),
              h("li", {}, "Copy the ", h("b", {}, "Web app URL"), " (it ends in /exec) and paste it here:")
            )
          ),
          card(
            "",
            ...field("Web app URL", "t-hook", S.emailWebhook, { placeholder: "https://script.google.com/macros/s/\u2026/exec" }),
            toggle("emailAuto", "Send automatically", "Email the minutes as soon as they are written."),
            toggle("emailPdf", "Attach a PDF", "A formatted A4 copy of the minutes."),
            toggle("emailWord", "Attach a Word file", "Opens in Word with tables intact."),
            toggle("emailTranscript", "Attach the transcript", "The full transcript as a text file."),
            h("div", { class: "btnrow" }, h("button", { class: "btn primary", onclick: async () => {
              await patch({ emailWebhook: $("t-hook").value.trim() });
              say(st, "Sending\u2026");
              try {
                const r = await sendMail({ subject: "Debrief test email", html: "<p>This is a test from <b>Debrief</b>. Your minutes will arrive like this.</p>", text: "This is a test from Debrief.", attachments: [] }, S);
                say(st, `Sent to ${r.to} \u2713 Check your inbox.`, "ok");
              } catch (e) {
                say(st, `Failed: ${e.message}`, "bad");
              }
            } }, "Send test email"), st)
          )
        ];
      },
      save: async () => patch({ emailWebhook: $("t-hook")?.value.trim() ?? S.emailWebhook })
    },
    {
      id: "share",
      label: "Share and calendar",
      kicker: "Step 8",
      title: "Share with your team",
      lede: "Optional. Debrief can send the minutes to colleagues and show who was invited versus who actually came.",
      optional: true,
      nodes: () => {
        const msg = status();
        return [
          card(
            "Who should get a copy",
            ...field("Default people", "t-share", S.shareList, { area: true, placeholder: "priya@company.com, ravi@company.com" }),
            p("You always get the email first. After you check names and numbers on the minutes page, press Share. Prefer it to go out by itself? Turn this on:", "hint"),
            toggle("shareAutoFlag", "Send to them automatically", "They get a copy the moment the minutes are written, without your review.", { onChange: (on) => patch({ shareMode: on ? "auto" : "review" }) }),
            p('For a recurring meeting with its own team, add lines like "Cadence Call | a@x.com, b@x.com" later in Settings \u2192 Email.', "hint")
          ),
          card(
            "Allow them in your script",
            p("Your script only mails people you allow, so nobody else can use it to send mail. After you add people, copy the updated script, replace the one at script.google.com, and deploy a new version (Deploy \u2192 Manage deployments \u2192 pencil \u2192 Version: New version \u2192 Deploy)."),
            toggle("shareDomains", "Allow everyone at their company", "Uses the part after the @, so new colleagues work without editing the script."),
            h("div", { class: "btnrow" }, h("button", { class: "btn", onclick: async () => {
              await patch({ shareList: $("t-share").value });
              await navigator.clipboard.writeText(scriptWithAllowList(Code_default, parseAddresses($("t-share").value), { domains: S.shareDomains }));
              say(msg, "Copied the script with these people allowed \u2713", "ok");
            } }, "Copy script with these people allowed"), msg)
          ),
          card(
            "Invited versus attended",
            toggle("calendarLookup", "Look up who was invited", "Reads each meeting's invite from your Google Calendar through the same script. Needs the authorize step from the email page to have been run, and a new deployment if you changed the script."),
            p("The minutes then include an attendance table: who came, who was absent, who joined late or left early, and anyone who was not invited. Who actually attended is read from the people shown in the Meet call.", "hint")
          )
        ];
      },
      save: async () => patch({ shareList: $("t-share")?.value ?? S.shareList })
    },
    {
      id: "local",
      label: "Local models",
      kicker: "Step 9",
      title: "Keeping everything on your computer",
      lede: "Optional. If you do not want meeting text to leave your PC, Debrief can use models running locally instead of Gemini.",
      optional: true,
      nodes: () => [
        card(
          "What is possible",
          h(
            "div",
            { class: "grid2" },
            h("div", { class: "mini" }, h("b", {}, "Writing the minutes"), "Ollama with Gemma, Qwen, Llama and others. Good for clear English or Hinglish, slower and weaker on long or messy meetings."),
            h("div", { class: "mini" }, h("b", {}, "Speech to text"), "A local Whisper-style server. Good for English and Hindi; Malayalam needs a Malayalam model.")
          ),
          p('Setup takes a few commands and one Debrief button each. Open Settings \u2192 Minutes and press "Use Ollama on this PC", then "Find my installed models".'),
          h("div", { class: "btnrow" }, h("a", { class: "btn", href: "options.html#minutes", target: "_blank" }, "Open Minutes settings"), h("a", { class: "btn", href: LOCAL_GUIDE, target: "_blank" }, "Read the local models guide"))
        ),
        card(
          "Other meeting apps",
          p('Recording, transcription, minutes and email work on any web meeting tab. For Zoom (in the browser), Teams, Webex, Whereby, Jitsi, GoTo Meeting, BlueJeans, Chime, Zoho Meeting and Skype for Web, Debrief also glows amber during a call, follows your mute button and stops when the call ends. This uses generic detection, so "Check page detection" in the popup tells you what it can read. Installed desktop apps (the Zoom or Teams program) cannot be recorded by a browser extension.')
        )
      ]
    },
    {
      id: "usage",
      label: "Limits and usage",
      kicker: "Step 10",
      title: "Keeping an eye on limits",
      lede: "Free services have daily limits. Debrief counts what it uses and tells you before and when you hit one.",
      optional: true,
      nodes: () => [
        card(
          "What you will see",
          h(
            "ol",
            { class: "how" },
            h("li", {}, h("b", {}, "A yellow warning in the popup"), " when a model is at 80% of its daily limit."),
            h("li", {}, h("b", {}, "A red alert and a Chrome notification"), " if a limit or a bad key stops a request. Nothing is lost: audio that could not be transcribed is kept and retried when you open the minutes page."),
            h("li", {}, h("b", {}, "The Usage page in Settings"), " with requests, tokens, audio minutes and the limits Debrief has learned from Google's own messages. Days roll over at midnight Pacific time.")
          )
        ),
        card("", p('Thorough minutes (the default) make a few extra requests per meeting to catch every action item. If you run out of free requests often, switch Settings \u2192 Minutes to "Quick".'), h("div", { class: "btnrow" }, h("a", { class: "btn", href: "options.html#usage", target: "_blank" }, "Open the Usage page")))
      ]
    },
    {
      id: "done",
      label: "All set",
      kicker: "Done",
      title: "You are ready",
      lede: "Here is where things stand. Anything unticked can be done later in Settings.",
      nodes: () => {
        const item = (ok, title, sub) => h("li", { class: ok ? "ok" : "" }, h("b", {}, title), h("span", { class: "sub" }, sub));
        return [
          card("Your setup", h(
            "ul",
            { class: "checklist" },
            item(tour.keyOk || !!S.geminiKey, "Gemini key", tour.keyOk ? "Tested and working." : S.geminiKey ? "Saved (not tested)." : "Not added yet: you need this to record."),
            item(micOk, "Microphone", micOk ? "Allowed." : "Not allowed yet. Only the other participants are recorded."),
            item(!!S.myName, "Your name", S.myName || "Not set."),
            item(!!S.dictionary.trim(), "Names and terms", S.dictionary.trim() ? `${S.dictionary.trim().split("\n").length} entries.` : "Empty. Add your team's names later."),
            item(mailReady(S), "Email", mailReady(S) ? "Ready." : "Not set up (optional)."),
            item(parseAddresses(S.shareList).length > 0, "Sharing", parseAddresses(S.shareList).length ? `${parseAddresses(S.shareList).length} people.` : "No one added (optional)."),
            item(S.autoStop, "Stops by itself", S.autoStop ? "On." : "Off: stop recordings manually.")
          )),
          card(
            "Cheat sheet",
            h(
              "div",
              { class: "grid2" },
              h("div", { class: "mini" }, h("b", {}, "Start or stop"), kbd(shortcuts["toggle-recording"] || "Alt+Shift+M"), " or the toolbar icon"),
              h("div", { class: "mini" }, h("b", {}, "My voice in or out"), kbd(shortcuts["toggle-mic"] || "Alt+Shift+K"), " or the popup switch"),
              h("div", { class: "mini" }, h("b", {}, "Past meetings"), "Popup \u2192 Meetings tab"),
              h("div", { class: "mini" }, h("b", {}, "Change anything"), "Popup \u2192 Settings")
            ),
            h("div", { class: "btnrow" }, h("a", { class: "btn", href: "options.html", target: "_blank" }, "Open Settings"), h("a", { class: "btn", href: GUIDE, target: "_blank" }, "Read the full guide"))
          ),
          h("div", { class: "callout" }, "Next: join an online meeting in Chrome, click the Debrief icon, and press Start recording this tab. You can reopen this tour any time from the popup (Take the tour).")
        ];
      }
    }
  ];
  function renderNav() {
    $("stepsNav").replaceChildren(
      ...STEPS.map((st, i) => {
        const b = h(
          "button",
          { class: `${i === tour.step ? "active" : ""} ${tour.visited.includes(i) && i !== tour.step ? "done" : ""}`, onclick: () => go(i) },
          h("span", { class: "dot" }, tour.visited.includes(i) && i !== tour.step ? "\u2713" : String(i + 1)),
          st.label,
          st.optional ? h("span", { class: "opt" }, "optional") : null
        );
        return b;
      })
    );
  }
  async function go(i) {
    const cur = STEPS[tour.step];
    if (cur?.save && $("stage").children.length) await cur.save().catch(() => {
    });
    if (cur && !tour.visited.includes(tour.step)) tour.visited.push(tour.step);
    tour.step = Math.max(0, Math.min(STEPS.length - 1, i));
    if (tour.step === STEPS.length - 1) tour.done = true;
    await saveTour();
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    const st = STEPS[tour.step];
    $("stage").replaceChildren(h("p", { class: "kicker" }, st.kicker), h("h1", {}, st.title), h("p", { class: "lede" }, st.lede), ...st.nodes());
    st.after?.();
    renderNav();
    $("count").textContent = `Step ${tour.step + 1} of ${STEPS.length}`;
    $("back").style.visibility = tour.step === 0 ? "hidden" : "visible";
    $("skip").style.display = st.optional ? "" : "none";
    $("next").textContent = tour.step === STEPS.length - 1 ? "Finish" : tour.step === 0 ? "Start the tour" : "Next";
    document.title = `${st.title} \xB7 Debrief`;
  }
  $("next").onclick = async () => {
    if (tour.step === STEPS.length - 1) {
      await go(tour.step);
      window.close();
      return;
    }
    await go(tour.step + 1);
  };
  $("skip").onclick = () => go(tour.step + 1);
  $("back").onclick = () => go(tour.step - 1);
  $("skipAll").onclick = async (e) => {
    e.preventDefault();
    tour.done = true;
    await saveTour();
    window.close();
  };
  (async () => {
    S = await getSettings();
    S.shareAutoFlag = S.shareMode === "auto";
    const saved = (await chrome.storage.local.get("tour")).tour;
    const fresh = new URLSearchParams(location.search).get("restart") === "1";
    tour = saved && !fresh && !saved.done ? { visited: [], keyOk: false, ...saved } : { step: 0, visited: [], keyOk: !!saved?.keyOk };
    micOk = await navigator.permissions.query({ name: "microphone" }).then((q) => q.state === "granted").catch(() => false);
    try {
      for (const c of await chrome.commands.getAll()) if (c.shortcut) shortcuts[c.name] = c.shortcut;
    } catch {
    }
    const at = STEPS.findIndex((s) => s.id === location.hash.slice(1));
    if (at >= 0) tour.step = at;
    render();
  })();
})();
