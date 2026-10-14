// LLM providers. generate() streams text deltas to onText and resolves with the full text.
import { geminiChainFetch, modelChain } from './gemini.js';
import { errorDetail } from './store.js';
import { record } from './usage.js';

// Models that support adaptive thinking, effort and server-side refusal fallbacks.
const MODERN_CLAUDE = /^claude-(opus-5|fable-5|sonnet-5-5)/;

// Claude through the Messages API with plain fetch (the official SDK added about 500 KB to every page).
async function anthropic({ settings, system, user, onText, signal, temperature }) {
  const model = settings.anthropicModel;
  const modern = MODERN_CLAUDE.test(model);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.anthropicKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = { model, max_tokens: 32000, system, messages: [{ role: 'user', content: user }], stream: true };
  if (modern) {
    // adaptive thinking does not accept a temperature, so none is sent for these models
    Object.assign(body, { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, fallbacks: 'default' });
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  } else if (temperature != null) body.temperature = temperature;
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name !== 'AbortError') record({ provider: 'anthropic', model, kind: 'llm', req: 1, fail: true });
    throw e;
  }
  if (!res.ok) {
    record({ provider: 'anthropic', model, kind: 'llm', req: 1, fail: true, rl: res.status === 429 });
    throw await httpError(res, 'Claude');
  }
  let text = '';
  let tin = 0;
  let tout = 0;
  let stop = '';
  let category = '';
  await readSse(res, (ev) => {
    if (ev.type === 'message_start') tin = ev.message?.usage?.input_tokens || 0;
    else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      text += ev.delta.text;
      onText(ev.delta.text);
    } else if (ev.type === 'message_delta') {
      stop = ev.delta?.stop_reason || stop;
      category = ev.delta?.stop_details?.category || category;
      tout = ev.usage?.output_tokens ?? tout;
    } else if (ev.type === 'error') throw Object.assign(new Error(`Claude: ${ev.error?.message || 'stream error'}`), { status: ev.error?.type === 'overloaded_error' ? 529 : 500 });
  });
  record({ provider: 'anthropic', model, kind: 'llm', req: 1, tin, tout });
  if (stop === 'refusal') throw new Error(`Claude declined this request${category ? ` (${category})` : ''}.`);
  if (stop === 'max_tokens') return `${text}\n\n_(Output hit the length limit and was cut off.)_`;
  return text;
}

// Reads an SSE response body and calls onEvent with each parsed `data:` JSON payload.
async function readSse(res, onEvent) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        onEvent(JSON.parse(data));
      } catch {}
    }
  }
}

async function httpError(res, provider) {
  let detail = '';
  try {
    detail = errorDetail(await res.text()).slice(0, 400);
  } catch {}
  return Object.assign(new Error(`${provider} HTTP ${res.status}: ${detail}`), { status: res.status });
}

// Network failures, rate limits and overloaded servers are worth another try; bad keys are not.
export function isRetryable(e) {
  if (e?.name === 'AbortError') return false;
  if (e?.status == null) return true;
  return e.status === 408 || e.status === 429 || e.status >= 500;
}

// OpenAI Chat Completions shape: OpenAI, Groq, OpenRouter, Ollama, LM Studio, etc.
async function openaiCompat({ settings, system, user, onText, signal, temperature }) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.oaKey) headers.Authorization = `Bearer ${settings.oaKey}`;
  const res = await fetch(`${settings.oaBase.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.oaModel,
      stream: true,
      ...(temperature != null ? { temperature } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  record({ provider: 'openai', model: settings.oaModel, kind: 'llm', req: 1, fail: !res.ok, rl: res.status === 429 });
  if (!res.ok) throw await httpError(res, 'LLM');
  let text = '';
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      ...(temperature != null ? { generationConfig: { temperature } } : {}),
    }),
  }, settings, { kind: 'llm' });
  if (!res.ok) throw await httpError(res, 'Gemini');
  let text = '';
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
  if (usage) record({ provider: 'gemini', model, kind: 'llm', tin: usage.promptTokenCount, tout: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) });
  return text;
}

const PROVIDERS = { anthropic, openai: openaiCompat, gemini };

export function modelLabel(s) {
  if (s.llmProvider === 'anthropic') return `Claude · ${s.anthropicModel}`;
  if (s.llmProvider === 'gemini') return `Gemini · ${s.geminiModel}`;
  return `${new URL(s.oaBase).host} · ${s.oaModel}`;
}

export function generate(opts) {
  const fn = PROVIDERS[opts.settings.llmProvider];
  if (!fn) throw new Error(`Unknown LLM provider ${opts.settings.llmProvider}`);
  return fn(opts);
}
