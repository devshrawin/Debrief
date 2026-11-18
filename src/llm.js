// LLM providers. generate() streams text deltas to onText and resolves with the full text.
// onMeta (optional) hears { truncated: true } when the reply stopped at the model's output limit (it is then incomplete).
import { geminiChainFetch, modelChain } from './gemini.js';
import { errorDetail } from './store.js';
import { record } from './usage.js';

// Models that support adaptive thinking, effort and server-side refusal fallbacks.
const MODERN_CLAUDE = /^claude-(opus-5|fable-5|sonnet-5-5)/;

// Claude through the Messages API with plain fetch (the official SDK added about 500 KB to every page).
// json: true asks for one JSON document. Claude has no switch for it (the prompt does the work), so it is ignored here.
async function anthropic({ settings, system, user, onText, signal, temperature, json, onMeta }) {
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
  let stopped = false;
  await readSse(res, (ev) => {
    if (ev.type === 'message_stop') stopped = true;
    else if (ev.type === 'message_start') tin = ev.message?.usage?.input_tokens || 0;
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
  if (!stopped && stop !== 'max_tokens') {
    // the stream ended without message_stop: the reply is incomplete
    onMeta?.({ truncated: true });
    if (!onMeta && !json) return `${text}\n\n_(The reply ended early and may be incomplete.)_`;
  }
  if (stop === 'max_tokens') {
    onMeta?.({ truncated: true });
    // a caller that hears it says so itself, and a note inside JSON would end up in the last item
    if (!onMeta && !json) return `${text}\n\n_(Output hit the length limit and was cut off.)_`;
  }
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
      if (data === '[DONE]') return true;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      onEvent(ev); // outside the try: an error event's throw must reach the caller
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
async function openaiCompat({ settings, system, user, onText, signal, temperature, json, onMeta }) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.oaKey) headers.Authorization = `Bearer ${settings.oaKey}`;
  const post = (withJson) =>
    fetch(`${settings.oaBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: settings.oaModel,
        stream: true,
        ...(temperature != null ? { temperature } : {}),
        ...(withJson ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  let res = await post(!!json);
  // JSON mode is optional: a server that does not know response_format must not lose the result over it, so step down once.
  if (json && (res.status === 400 || res.status === 422)) {
    record({ provider: 'openai', model: settings.oaModel, kind: 'llm', req: 1, fail: true });
    res = await post(false);
  }
  record({ provider: 'openai', model: settings.oaModel, kind: 'llm', req: 1, fail: !res.ok, rl: res.status === 429 });
  if (!res.ok) throw await httpError(res, 'LLM');
  let text = '';
  let cut = false;
  let finished = false;
  const done = await readSse(res, (ev) => {
    const d = ev.choices?.[0]?.delta?.content;
    if (d) {
      text += d;
      onText(d);
    }
    if (ev.choices?.[0]?.finish_reason) finished = true;
    if (ev.choices?.[0]?.finish_reason === 'length') cut = true;
  });
  if (!finished && !done && text) cut = true; // OpenAI-style servers end a whole reply with a finish reason or [DONE]
  if (cut) onMeta?.({ truncated: true });
  return text;
}

async function gemini({ settings, system, user, onText, signal, temperature, json, onMeta }) {
  const urlFor = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`;
  const send = (withJson) => {
    const generationConfig = { ...(temperature != null ? { temperature } : {}), ...(withJson ? { responseMimeType: 'application/json' } : {}) };
    return geminiChainFetch(modelChain(settings.geminiModel), urlFor, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      }),
    }, settings, { kind: 'llm' });
  };
  let sent = await send(!!json);
  // JSON mode is optional: a model that rejects it with a 400 is asked again without it.
  if (json && !sent.res.ok && sent.res.status === 400) sent = await send(false);
  const { res, model } = sent;
  if (!res.ok) throw await httpError(res, 'Gemini');
  let text = '';
  let usage = null;
  let cut = false;
  let finished = false;
  await readSse(res, (ev) => {
    if (ev.usageMetadata) usage = ev.usageMetadata;
    if (ev.candidates?.[0]?.finishReason) finished = true;
    if (ev.candidates?.[0]?.finishReason === 'MAX_TOKENS') cut = true;
    for (const p of ev.candidates?.[0]?.content?.parts || []) {
      if (p.text && !p.thought) {
        text += p.text;
        onText(p.text);
      }
    }
  });
  if (usage) record({ provider: 'gemini', model, kind: 'llm', tin: usage.promptTokenCount, tout: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) });
  if (!finished && text) cut = true;
  if (cut) onMeta?.({ truncated: true });
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
