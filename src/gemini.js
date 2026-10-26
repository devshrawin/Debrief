// fetch() for the Gemini API that falls back to the backup key when the main key is
// rate-limited, out of quota, rejected, or the server errors.
const FALLBACK_STATUS = (s) => s === 400 || s === 401 || s === 403 || s === 429 || s >= 500;

import { record, learnLimit, nextQuotaReset } from './usage.js';

// ---- cooldown: a model that has just said "over your limit" is skipped until it can answer again ----
// Each failed request against an exhausted model wasted time and quota (49 of 67 requests in one test run).
const cool = new Map();
let coolLoaded = 0;

async function loadCool() {
  if (Date.now() - coolLoaded < 5000) return;
  coolLoaded = Date.now();
  try {
    const { modelCooldown } = await chrome.storage.local.get('modelCooldown');
    for (const [m, until] of Object.entries(modelCooldown || {})) if (until > (cool.get(m) || 0)) cool.set(m, until);
  } catch {}
}

const untilPacificMidnight = (now) => nextQuotaReset(now);

// How long a 429 means "stay away": until the daily quota resets, or the retry time Google gave, else a minute.
export function cooldownFor(text, now = Date.now()) {
  const t = String(text || '');
  if (/PerDay|per day|daily/i.test(t)) return untilPacificMidnight(now);
  const secs = Number((t.match(/retry in\s*([\d.]+)\s*s/i) || [])[1]);
  return now + Math.min(15 * 60000, (secs > 0 ? secs + 2 : 60) * 1000);
}

export function coolDown(model, until) {
  cool.set(model, until);
  try {
    chrome.storage.local.get('modelCooldown').then(({ modelCooldown }) => {
      const keep = Object.fromEntries(Object.entries({ ...(modelCooldown || {}), [model]: until }).filter(([, u]) => u > Date.now()));
      chrome.storage.local.set({ modelCooldown: keep });
    });
  } catch {}
}

export async function isCooling(model) {
  await loadCool();
  return coolingNow(model);
}

export const coolingNow = (model, now = Date.now()) => (cool.get(model) || 0) > now;
export function resetCooldowns() {
  cool.clear();
  coolLoaded = 0;
}

// The models to try, leaving out any that are cooling. If all are cooling the list is returned as it is.
export async function usable(models) {
  await loadCool();
  const ok = models.filter((m) => !coolingNow(m));
  return ok.length ? ok : models;
}

// True when every one of these models is over its limit for more than a few minutes: retrying now is pointless.
export async function allExhausted(models, now = Date.now()) {
  await loadCool();
  return models.length > 0 && models.every((m) => (cool.get(m) || 0) > now + 5 * 60000);
}

function note(url, res, meta) {
  const model = (url.match(/models\/([^:/?]+)/) || [])[1] || '-';
  const e = { provider: 'gemini', model, kind: meta.kind || (/stream/i.test(url) ? 'llm' : 'stt'), req: 1 };
  if (res && res.ok) return record(e);
  e.fail = true;
  e.rl = res?.status === 429;
  if (!res) return record(e);
  res.clone().text().then((t) => {
    if (e.rl && model !== '-') coolDown(model, cooldownFor(t));
    record({ ...e, learned: learnLimit(t) });
  }, () => record(e));
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

// The main key first, then each backup key in order (the first backup, then the list), while a key is out of quota,
// rejected, or the network failed. Any other answer is the answer.
export const keyOrder = (settings) => [settings.geminiKey, settings.geminiKey2, ...(settings.geminiBackups || [])].filter(Boolean);

async function geminiFetchInner(url, init, settings) {
  const keys = keyOrder(settings);
  const call = (key) => fetch(url, { ...init, headers: { ...init.headers, 'x-goog-api-key': key } });
  let res = null;
  for (let i = 0; i < keys.length; i++) {
    const last = i === keys.length - 1;
    res = await call(keys[i]).catch((e) => {
      if (last || e.name === 'AbortError') throw e;
      return null; // network error: try the next key
    });
    if (last || (res && (res.ok || !FALLBACK_STATUS(res.status)))) return res;
  }
  return res;
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
  for (const m of await usable(models)) {
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
