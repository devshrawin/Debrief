// Helpers for models running on this computer (Ollama and Whisper-compatible servers).

export const OLLAMA_BASE = 'http://localhost:11434/v1';
export const WHISPER_BASE = 'http://localhost:8000/v1';

export function isLocalBase(base) {
  try {
    const h = new URL(base).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

// Plain-language reason for a failed connection to a local server.
export function explain(err, status, what = 'Ollama') {
  if (status === 403) return `${what} refused the extension. Start it with the environment variable OLLAMA_ORIGINS=chrome-extension://* (see the local models guide), then restart it.`;
  if (status === 404) return `${what} answered but this address is wrong. For Ollama use http://localhost:11434/v1.`;
  if (status) return `${what} answered with HTTP ${status}.`;
  const m = String(err?.message || err || '');
  if (/failed to fetch|networkerror|load failed|connection|refused/i.test(m)) return `Could not reach ${what}. Is it running? For Ollama, start it with "ollama serve", and allow the extension with OLLAMA_ORIGINS=chrome-extension://*.`;
  return `${what}: ${m || 'unknown error'}`;
}

const origin = (base) => new URL(base).origin;

// Lists the models installed in Ollama. Returns { ok, models: [{ name, sizeGB }] } or { ok:false, message }.
export async function listOllamaModels(base = OLLAMA_BASE, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`${origin(base)}/api/tags`, { signal: AbortSignal.timeout(6000) });
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
  if (!res.ok) return { ok: false, message: explain(null, res.status) };
  const j = await res.json().catch(() => ({}));
  const models = (j.models || []).map((m) => ({ name: m.name, sizeGB: Math.round(((m.size || 0) / 1e9) * 10) / 10 }));
  if (!models.length) return { ok: false, message: 'Ollama is running but has no models yet. Install one, for example: ollama pull gemma3' };
  return { ok: true, models };
}

// How much text the model will actually read. Ollama silently truncates beyond its context length.
export async function ollamaContext(model, base = OLLAMA_BASE, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${origin(base)}/api/show`, { method: 'POST', body: JSON.stringify({ model, name: model }), signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = await res.json();
    const set = Number((String(j.parameters || '').match(/num_ctx\s+(\d+)/) || [])[1]);
    const max = Object.entries(j.model_info || {}).find(([k]) => k.endsWith('.context_length'))?.[1];
    return { configured: set || null, max: max ? Number(max) : null };
  } catch {
    return null;
  }
}

// Words of transcript a context window of `tokens` can hold, leaving room for prompts and the answer.
export const wordsForContext = (tokens) => Math.max(500, Math.floor(tokens * 0.45));

export function contextAdvice(ctx, transcriptWords = 9000) {
  if (!ctx) return '';
  const have = ctx.configured || 4096;
  const need = Math.ceil(transcriptWords / 0.45);
  if (have >= need) return `Context length ${have} tokens is enough for about ${wordsForContext(have)} words of transcript.`;
  return `Context length is ${ctx.configured ? ctx.configured : 'Ollama\'s default (about 4096)'} tokens, enough for roughly ${wordsForContext(have)} words. A one-hour meeting can reach ${transcriptWords} words, and Ollama silently cuts off what does not fit. Set OLLAMA_CONTEXT_LENGTH=16384 (or more) and restart Ollama.`;
}
