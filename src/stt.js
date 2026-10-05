// Speech-to-text providers. Each takes a 16 kHz mono WAV Blob and returns plain text.

class SttError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

import { geminiFetch, modelChain } from './gemini.js';
import { isLoopNoise } from './noise.js';
import { errorDetail } from './store.js';

async function check(res, provider) {
  if (res.ok) return res.json();
  let detail = '';
  try {
    detail = errorDetail(await res.text()).slice(0, 300);
  } catch {}
  throw new SttError(`${provider} HTTP ${res.status}: ${detail}`, res.status);
}

async function sarvam(wav, s) {
  const fd = new FormData();
  fd.append('file', wav, 'chunk.wav');
  fd.append('model', s.sarvamModel);
  fd.append('mode', s.sarvamMode);
  fd.append('language_code', s.sarvamLanguage);
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
  if (s.sttPrompt) fd.append('prompt', s.sttPrompt);
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
  const body = { contents: [{ role: 'user', parts }] };
  if (/transcribe/.test(model)) {
    body.generationConfig = { audioTranscriptionConfig: { mode: 'SMART' } };
  } else {
    parts.unshift({
      text: 'Transcribe this meeting audio exactly as spoken. It may mix Hindi and English: write Hindi in Devanagari and English words in English. Output only the transcript text, with no commentary. If there is no intelligible speech, output nothing.',
    });
  }
  const res = await geminiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, s);
  const j = await check(res, 'Gemini');
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

export async function transcribe(wav, settings) {
  const fn = PROVIDERS[settings.sttProvider];
  if (!fn) throw new Error(`Unknown STT provider ${settings.sttProvider}`);
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      const text = (await fn(wav, settings)).trim();
      return isLoopNoise(text) ? '' : text;
    } catch (e) {
      const retryable = !(e instanceof SttError) || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= 3) throw e;
      // Free-tier rate limits reset per minute, so back off harder on 429.
      await new Promise((r) => setTimeout(r, e.status === 429 ? Math.max(delay, 20000) : delay));
      delay *= 2;
    }
  }
}
