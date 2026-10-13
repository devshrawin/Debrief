// fetch() for the Gemini API that falls back to the backup key when the main key is
// rate-limited, out of quota, rejected, or the server errors.
const FALLBACK_STATUS = (s) => s === 400 || s === 401 || s === 403 || s === 429 || s >= 500;

import { record, learnLimit } from './usage.js';

function note(url, res, meta) {
  const model = (url.match(/models\/([^:/?]+)/) || [])[1] || '-';
  const e = { provider: 'gemini', model, kind: meta.kind || (/stream/i.test(url) ? 'llm' : 'stt'), req: 1 };
  if (res && res.ok) return record(e);
  e.fail = true;
  e.rl = res?.status === 429;
  if (!res) return record(e);
  res.clone().text().then((t) => record({ ...e, learned: learnLimit(t) }), () => record(e));
}

export async function geminiFetch(url, init, settings, meta = {}) {
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
  const call = (key) => fetch(url, { ...init, headers: { ...init.headers, 'x-goog-api-key': key } });
  const res = await call(settings.geminiKey).catch((e) => {
    if (!settings.geminiKey2 || e.name === 'AbortError') throw e;
    return null; // network error: try the backup key
  });
  if (res?.ok || !settings.geminiKey2 || (res && !FALLBACK_STATUS(res.status))) return res;
  return call(settings.geminiKey2);
}

// Free-tier quotas are per model per project, so a second key in the same project does not help
// when one model is exhausted. Try other general models before giving up.
export const GENERAL_FALLBACKS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'];
const MODEL_STATUS = (s) => s === 404 || s === 429 || s >= 500;

export const modelChain = (primary) => [...new Set([primary, ...GENERAL_FALLBACKS].filter(Boolean))];

// Runs geminiFetch against each model in turn; returns the first response that is ok or whose
// failure is not about this model (bad request, bad key) and reports which model answered.
export async function geminiChainFetch(models, urlFor, init, settings, meta = {}) {
  let last, lastErr;
  for (const m of models) {
    try {
      const res = await geminiFetch(urlFor(m), init, settings, meta);
      if (res.ok || !MODEL_STATUS(res.status)) return { res, model: m };
      last = { res, model: m };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  if (last) return last;
  throw lastErr;
}
