// Speech-to-text providers. Each takes a 16 kHz mono WAV Blob and returns plain text.

class SttError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

import { geminiFetch, modelChain, usable, allExhausted, isCooling } from './gemini.js';
import { cleanTranscript, cleanTerms, latinShare, looksTransliterated } from './sttclean.js';
import { isLoopNoise } from './noise.js';
import { errorDetail, DEFAULTS } from './store.js';
import { record } from './usage.js';
import { parseDictionary, hintTerms } from './dictionary.js';
import { chosenLanguages, languagesOf, languageHint, geminiCodes, singleLanguage, joinNames, SARVAM_CODES } from './languages.js';

const DEFAULT_STT_PROMPT = DEFAULTS.sttPrompt;

async function check(res, provider) {
  if (res.ok) return res.json();
  let detail = '';
  try {
    detail = errorDetail(await res.text()).slice(0, 300);
  } catch {}
  throw new SttError(`${provider} HTTP ${res.status}: ${detail}`, res.status);
}

// Names and terms from the personal dictionary, as spelling hints for the speech models.
const sttTerms = (s) => hintTerms(parseDictionary(s.dictionary), cleanTerms(s.learnedNames || [])).slice(0, 80);
const audioSeconds = (wav) => Math.max(0, (wav.size - 44) / 32000);
// `codes` go to Gemini's transcription model (none = it detects); `hint` is the prompt for general models.
const lang = (s) => ({ codes: geminiCodes(chosenLanguages(s)), hint: languageHint(languagesOf(s)) });

async function sarvam(wav, s) {
  const fd = new FormData();
  fd.append('file', wav, 'chunk.wav');
  fd.append('model', s.sarvamModel);
  fd.append('mode', s.sarvamMode);
  // An explicit Sarvam language wins; otherwise follow the meeting language.
  const only = singleLanguage(chosenLanguages(s) || []);
  fd.append('language_code', s.sarvamLanguage !== 'unknown' ? s.sarvamLanguage : only && SARVAM_CODES.has(only.code) ? only.bcp : 'unknown');
  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': s.sarvamKey },
    body: fd,
  });
  const j = await check(res, 'Sarvam');
  return j.transcript || '';
}

// Deepgram's utterances (with speaker numbers) come back next to the transcript. If an account or model refuses those
// options, the piece is read again without them: a transcript must never be lost because of an optional setting.
async function deepgram(wav, s) {
  const call = async (extra) => {
    const q = new URLSearchParams({
      model: s.deepgramModel,
      language: 'multi', // Hindi-English code-switching on nova-3
      smart_format: 'true',
      punctuate: 'true',
      ...extra,
    });
    for (const t of sttTerms(s).slice(0, 50)) q.append('keyterm', t);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${s.deepgramKey}`, 'Content-Type': 'audio/wav' },
      body: wav,
    });
    return check(res, 'Deepgram');
  };
  let j;
  try {
    j = await call({ utterances: 'true', diarize: 'true' });
  } catch (e) {
    if (!(e.status === 400 && /diariz|utterance/i.test(e.message))) throw e;
    j = await call({});
  }
  const text = j.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  const utterances = (j.results?.utterances || []).map((u) => ({ t0: u.start, t1: u.end, text: u.transcript, spk: Number.isInteger(u.speaker) ? u.speaker : undefined }));
  return { text, utterances };
}

// Base URLs whose server refused response_format=verbose_json (it then gets plain json straight away).
const NO_VERBOSE = new Set();
export const _resetVerbose = () => NO_VERBOSE.clear();

// OpenAI-compatible /audio/transcriptions: OpenAI, Groq, or a local Whisper server. verbose_json also carries the
// segments with their start and end; a server that does not know it is asked again for plain json.
async function openaiCompat(wav, s) {
  const base = s.sttBase.replace(/\/+$/, '');
  const chosen = chosenLanguages(s);
  const only = singleLanguage(chosen || []);
  const lead = chosen && s.sttPrompt === DEFAULT_STT_PROMPT ? `${joinNames(chosen)} office meeting. ${languageHint(chosen)}` : s.sttPrompt;
  const prompt = [lead, sttTerms(s).length ? `Names: ${sttTerms(s).join(', ')}.` : ''].filter(Boolean).join(' ');
  const call = async (format) => {
    const fd = new FormData();
    fd.append('file', wav, 'chunk.wav');
    fd.append('model', s.sttModel);
    fd.append('response_format', format);
    if (only) fd.append('language', only.code);
    if (prompt) fd.append('prompt', prompt);
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: s.sttKey ? { Authorization: `Bearer ${s.sttKey}` } : {}, body: fd });
    return check(res, 'Transcription');
  };
  if (!NO_VERBOSE.has(base)) {
    try {
      const j = await call('verbose_json');
      if (typeof j.text === 'string') {
        const utterances = Array.isArray(j.segments) ? j.segments.map((g) => ({ t0: g.start, t1: g.end, text: g.text })) : null;
        return { text: j.text, utterances };
      }
    } catch (e) {
      if (![400, 415, 422].includes(e.status)) throw e;
    }
    NO_VERBOSE.add(base);
  }
  return (await call('json')).text || '';
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Gemini generateContent with inline audio. Transcription models (gemini-3.5-transcribe) take
// audioTranscriptionConfig; general models (e.g. gemini-3.8-flash) are told what to do in a prompt.
// which request shape each general model accepted last time (0 = strictest)
const GENERAL_STEP = new Map();
export const _resetGeneralSteps = () => GENERAL_STEP.clear();

async function geminiCall(wav, s, model) {
  const parts = [{ inlineData: { mimeType: 'audio/wav', data: await toBase64(wav) } }];
  const post = async (body) => {
    const res = await geminiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, s);
    return check(res, 'Gemini');
  };
  let j;
  if (/transcribe/.test(model)) {
    const codes = lang(s).codes;
    const cfg = (withCodes) => ({ contents: [{ role: 'user', parts }], generationConfig: { audioTranscriptionConfig: { mode: 'SMART', ...(withCodes && codes ? { languageCodes: codes } : {}) } } });
    try {
      j = await post(cfg(true));
    } catch (e) {
      // If the API rejects the language hint, transcribe without it instead of failing the chunk.
      if (!(codes && e.status === 400 && /languageCodes|language_codes|Invalid JSON/i.test(e.message))) throw e;
      j = await post(cfg(false));
    }
  } else {
    const terms = sttTerms(s);
    const body = (generationConfig) => ({
      contents: [{
        role: 'user',
        parts: [{ text: `Transcribe this meeting audio exactly as spoken. ${lang(s).hint} Write English words in English letters (never in Devanagari), Hindi in Devanagari, Malayalam in Malayalam script. ${terms.length ? `These names and terms may be spoken, spell them exactly like this: ${terms.join(', ')}. ` : ''}Output ONLY the words that were said, as plain running text. Do not explain, do not think out loud, do not list rules or timestamps, do not write speaker names or labels, do not repeat anything. If there is no intelligible speech, output nothing.` }, ...parts],
      }],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    });
    // From the strictest request to the plainest. Models differ in which settings they accept, and the API answers a
    // setting it does not know with a bare "400 invalid argument", so ANY 400 steps down to the next, and the step that
    // worked is remembered for the next piece. A transcript must never be lost because of an optional setting.
    const ladder = [{ temperature: 0, thinkingConfig: { thinkingBudget: 0 } }, { temperature: 0 }, {}];
    let step = GENERAL_STEP.get(model) || 0;
    for (;;) {
      try {
        j = await post(body(ladder[step]));
        GENERAL_STEP.set(model, step);
        break;
      } catch (e) {
        if (e.status !== 400 || step >= ladder.length - 1) throw e;
        step++;
      }
    }
  }
  record({ provider: 'gemini', model, kind: 'stt', tin: j.usageMetadata?.promptTokenCount, tout: j.usageMetadata?.candidatesTokenCount, audioSec: audioSeconds(wav) });
  const text = (j.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');
  return cleanTranscript(text, sttTerms(s)).text; // thinking that leaked into the answer, repeats and made-up speaker labels are removed
}

// A passage of the dedicated model that is all Malayalam/Hindi letters, in a meeting that mixes English in, is read once by a
// general model (whose prompt says English words go in English letters); that answer is used when it clearly has them. A
// recording may spend only a few of these extra requests.
const SCRIPT_CHECKS = { left: 8 };
export const resetSttBudget = () => {
  SCRIPT_CHECKS.left = 8;
};
async function preferEnglishLetters(first, wav, s) {
  const chosen = chosenLanguages(s);
  if (!looksTransliterated(first) || (chosen && !chosen.some((l) => l.code === 'en')) || SCRIPT_CHECKS.left <= 0) return first;
  SCRIPT_CHECKS.left--;
  for (const m of await usable(modelChain(s.geminiModel))) {
    try {
      const alt = await geminiCall(wav, s, m);
      return latinShare(alt) >= 0.12 && alt.length >= first.length * 0.5 ? alt : first;
    } catch {}
  }
  return first;
}

// The dedicated transcription model returns an empty reply when it judges the audio to be
// non-speech; give a general model one go before treating the chunk as empty.
async function gemini(wav, s) {
  let first = '';
  let err;
  try {
    // a transcription model that just reported its limit is skipped: go straight to the general models
    if (!(await isCooling(s.sttGeminiModel))) first = await geminiCall(wav, s, s.sttGeminiModel);
  } catch (e) {
    err = e;
  }
  if (first.trim() || !/transcribe/.test(s.sttGeminiModel)) {
    if (err) throw err;
    return /transcribe/.test(s.sttGeminiModel) ? preferEnglishLetters(first, wav, s) : first;
  }
  // Empty reply, or the transcribe model is out of quota: try general models, which also have
  // separate quotas.
  let lastErr = err;
  for (const m of await usable(modelChain(s.geminiModel))) {
    try {
      // A model that answers, even with nothing, has judged the chunk: no speech.
      return await geminiCall(wav, s, m);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return '';
}

const PROVIDERS = { gemini, sarvam, deepgram, openai: openaiCompat };

const sttModelName = (s) => ({ sarvam: s.sarvamModel, deepgram: s.deepgramModel, openai: s.sttModel })[s.sttProvider];

// Some general models answer with a timestamp at the start of each line ("00:04Child Development,"). Debrief keeps
// its own times, so when most lines carry one they are removed and the lines are joined into running text.
export function stripTimestamps(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const stamp = /^[\[(]?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?[\])]?\s*[-–:]?\s*/;
  if (lines.length < 3 || lines.filter((l) => stamp.test(l)).length < lines.length * 0.6) return String(text || '');
  return lines.map((l) => l.replace(stamp, '')).filter(Boolean).join(' ');
}

// Makes the utterances a provider gave fit one piece: same cleaning as the text, times inside the piece and in order.
function tidyUtterances(list, text, dur, terms) {
  if (!Array.isArray(list) || !text) return null;
  const clamp = (x) => Math.min(dur, Math.max(0, Number(x) || 0));
  const out = [];
  for (const u of list) {
    const t = cleanTranscript(stripTimestamps(u?.text), terms).text.trim();
    if (!t || isLoopNoise(t)) continue;
    const t0 = clamp(u.t0);
    const o = { t0, t1: Math.max(t0, clamp(u.t1)), text: t };
    if (Number.isInteger(u.spk)) o.spk = u.spk;
    out.push(o);
  }
  return out.length ? out.sort((a, b) => a.t0 - b.t0) : null;
}

// { text, utterances }: utterances is null or [{ t0, t1, text, spk? }] in seconds from the start of this piece
// (spk only means something inside this one piece). One retry loop serves both transcribe() and transcribeDetailed().
export async function transcribeDetailed(wav, settings) {
  const fn = PROVIDERS[settings.sttProvider];
  if (!fn) throw new Error(`Unknown STT provider ${settings.sttProvider}`);
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      const got = await fn(wav, settings);
      if (settings.sttProvider !== 'gemini') record({ provider: settings.sttProvider, model: sttModelName(settings), kind: 'stt', req: 1, audioSec: audioSeconds(wav) });
      const raw = typeof got === 'string' ? got : got?.text;
      const text = stripTimestamps(raw).trim();
      if (isLoopNoise(text)) return { text: '', utterances: null };
      return { text, utterances: typeof got === 'string' ? null : tidyUtterances(got?.utterances, text, audioSeconds(wav), sttTerms(settings)) };
    } catch (e) {
      if (settings.sttProvider !== 'gemini') record({ provider: settings.sttProvider, model: sttModelName(settings), kind: 'stt', req: 1, fail: true, rl: e.status === 429 });
      const retryable = !(e instanceof SttError) || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= 3) throw e;
      // Every model is over its daily limit: do not sit through minutes of backoff, keep the audio for later.
      if (settings.sttProvider === 'gemini' && e.status === 429 && (await allExhausted([settings.sttGeminiModel, ...modelChain(settings.geminiModel)]))) throw e;
      // Free-tier rate limits reset per minute, so back off harder on 429.
      await new Promise((r) => setTimeout(r, e.status === 429 ? Math.max(delay, 20000) : delay));
      delay *= 2;
    }
  }
}

export async function transcribe(wav, settings) {
  return (await transcribeDetailed(wav, settings)).text;
}
