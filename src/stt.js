// Speech-to-text providers. Each takes a 16 kHz mono WAV Blob and returns plain text.

class SttError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

import { geminiFetch, modelChain } from './gemini.js';
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
const sttTerms = (s) => hintTerms(parseDictionary(s.dictionary), s.learnedNames || []).slice(0, 80);
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

async function deepgram(wav, s) {
  const q = new URLSearchParams({
    model: s.deepgramModel,
    language: 'multi', // Hindi-English code-switching on nova-3
    smart_format: 'true',
    punctuate: 'true',
  });
  for (const t of sttTerms(s).slice(0, 50)) q.append('keyterm', t);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
    method: 'POST',
    headers: { Authorization: `Token ${s.deepgramKey}`, 'Content-Type': 'audio/wav' },
    body: wav,
  });
  const j = await check(res, 'Deepgram');
  return j.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

// OpenAI-compatible /audio/transcriptions: OpenAI, Groq, or a local Whisper server.
async function openaiCompat(wav, s) {
  const fd = new FormData();
  fd.append('file', wav, 'chunk.wav');
  fd.append('model', s.sttModel);
  fd.append('response_format', 'json');
  const chosen = chosenLanguages(s);
  const only = singleLanguage(chosen || []);
  if (only) fd.append('language', only.code);
  const base = chosen && s.sttPrompt === DEFAULT_STT_PROMPT ? `${joinNames(chosen)} office meeting. ${languageHint(chosen)}` : s.sttPrompt;
  const prompt = [base, sttTerms(s).length ? `Names: ${sttTerms(s).join(', ')}.` : ''].filter(Boolean).join(' ');
  if (prompt) fd.append('prompt', prompt);
  const headers = s.sttKey ? { Authorization: `Bearer ${s.sttKey}` } : {};
  const res = await fetch(`${s.sttBase.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: fd,
  });
  const j = await check(res, 'Transcription');
  return j.text || '';
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Gemini generateContent with inline audio. Transcription models (gemini-3.5-transcribe) take
// audioTranscriptionConfig; general models (e.g. gemini-3.8-flash) are told what to do in a prompt.
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
    j = await post({
      contents: [{
        role: 'user',
        parts: [{ text: `Transcribe this meeting audio exactly as spoken. ${lang(s).hint} ${sttTerms(s).length ? `These names and terms may be spoken, spell them exactly like this: ${sttTerms(s).join(', ')}. ` : ''}Output only the transcript text, with no commentary. If there is no intelligible speech, output nothing.` }, ...parts],
      }],
    });
  }
  record({ provider: 'gemini', model, kind: 'stt', tin: j.usageMetadata?.promptTokenCount, tout: j.usageMetadata?.candidatesTokenCount, audioSec: audioSeconds(wav) });
  return (j.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');
}

// The dedicated transcription model returns an empty reply when it judges the audio to be
// non-speech; give a general model one go before treating the chunk as empty.
async function gemini(wav, s) {
  let first = '';
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
  // Empty reply, or the transcribe model is out of quota: try general models, which also have
  // separate quotas.
  let lastErr = err;
  for (const m of modelChain(s.geminiModel)) {
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

export async function transcribe(wav, settings) {
  const fn = PROVIDERS[settings.sttProvider];
  if (!fn) throw new Error(`Unknown STT provider ${settings.sttProvider}`);
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await fn(wav, settings);
      if (settings.sttProvider !== 'gemini') record({ provider: settings.sttProvider, model: sttModelName(settings), kind: 'stt', req: 1, audioSec: audioSeconds(wav) });
      const text = raw.trim();
      return isLoopNoise(text) ? '' : text;
    } catch (e) {
      if (settings.sttProvider !== 'gemini') record({ provider: settings.sttProvider, model: sttModelName(settings), kind: 'stt', req: 1, fail: true, rl: e.status === 429 });
      const retryable = !(e instanceof SttError) || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= 3) throw e;
      // Free-tier rate limits reset per minute, so back off harder on 429.
      await new Promise((r) => setTimeout(r, e.status === 429 ? Math.max(delay, 20000) : delay));
      delay *= 2;
    }
  }
}
