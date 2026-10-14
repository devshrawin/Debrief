// LLM providers. generate() streams text deltas to onText and resolves with the full text.
import Anthropic from '@anthropic-ai/sdk';
import { geminiChainFetch, modelChain } from './gemini.js';
import { errorDetail } from './store.js';
import { record } from './usage.js';

// Models that support adaptive thinking, effort and server-side refusal fallbacks.
const MODERN_CLAUDE = /^claude-(opus-5|fable-5|sonnet-5-5)/;

async function anthropic({ settings, system, user, onText, signal }) {
  const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
  const model = settings.anthropicModel;
  const params = {
    model,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (MODERN_CLAUDE.test(model)) {
    Object.assign(params, {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  }
  const stream = client.beta.messages.stream(params, { signal });
  stream.on('text', onText);
  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    record({ provider: 'anthropic', model, kind: 'llm', req: 1, fail: true, rl: e?.status === 429 });
    throw e;
  }
  record({ provider: 'anthropic', model, kind: 'llm', req: 1, tin: msg.usage?.input_tokens, tout: msg.usage?.output_tokens });
  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}.`);
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (msg.stop_reason === 'max_tokens') return `${text}\n\n_(Output hit the length limit and was cut off.)_`;
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
