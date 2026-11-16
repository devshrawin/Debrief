// Checks the model names in Settings against what each provider says it offers, instead of trusting hardcoded names.
// Providers: 'gemini', 'anthropic', 'openai' (chat: oaBase/oaKey), 'openai-speech' (speech: sttBase/sttKey), 'deepgram', 'sarvam'.
// Only the providers' documented list-models calls are used, and nothing here prints or stores a key.
import { keyOrder, modelChain } from './gemini.js';

const NO_LIST = 'This provider has no model list to check against.';
const TTL = 6 * 3600 * 1000;
const PAGES = 5;

// Anything that looks like a key is cut out of error text; so is every key the settings hold.
function scrub(text, settings = {}) {
  let t = String(text ?? '');
  const keys = [...keyOrder(settings), settings.anthropicKey, settings.oaKey, settings.sttKey, settings.sarvamKey, settings.deepgramKey].filter((k) => k && k.length > 5);
  for (const k of keys) t = t.split(k).join('[key]');
  return t.replace(/AIza[\w-]{20,}|sk-[\w-]{10,}|(key|token)=[^&\s"']+/gi, '[key]').slice(0, 200);
}

async function getJson(url, headers, { fetch, signal }, settings) {
  let res;
  try {
    res = await fetch(url, { headers, signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { ok: false, error: `Could not reach the server (${scrub(e?.message || e, settings)}).` };
  }
  if (!res.ok) {
    let body = '';
    try {
      body = JSON.parse(await res.text())?.error?.message || '';
    } catch {}
    return { ok: false, status: res.status, error: `The provider answered ${res.status}${body ? `: ${scrub(body, settings)}` : ''}.` };
  }
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, status: res.status, error: 'The provider answered, but not with a model list.' };
  }
}

export async function listModels(provider, settings = {}, { fetch = globalThis.fetch, signal } = {}) {
  const deps = { fetch, signal };
  if (provider === 'gemini') {
    const key = keyOrder(settings)[0];
    if (!key) return { ok: false, error: 'No Gemini key is set.' };
    const models = [];
    let token = '';
    for (let page = 0; page < PAGES; page++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const r = await getJson(url, { 'x-goog-api-key': key }, deps, settings);
      if (!r.ok) return r;
      for (const m of r.json.models || []) {
        const id = String(m.name || '').replace(/^models\//, '');
        if (!id) continue;
        const o = { id, generate: (m.supportedGenerationMethods || []).includes('generateContent') };
        if (m.displayName) o.label = m.displayName;
        if (/transcribe/.test(id)) o.audio = true;
        models.push(o);
      }
      token = r.json.nextPageToken || '';
      if (!token) break;
    }
    return { ok: true, models };
  }
  if (provider === 'anthropic') {
    if (!settings.anthropicKey) return { ok: false, error: 'No Claude key is set.' };
    const headers = { 'x-api-key': settings.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    const r = await getJson('https://api.anthropic.com/v1/models?limit=1000', headers, deps, settings);
    if (!r.ok) return r;
    return { ok: true, models: (r.json.data || []).filter((m) => m.id).map((m) => ({ id: m.id, ...(m.display_name ? { label: m.display_name } : {}) })) };
  }
  if (provider === 'openai' || provider === 'openai-speech') {
    const speech = provider === 'openai-speech';
    const base = String((speech ? settings.sttBase : settings.oaBase) || '').replace(/\/+$/, '');
    const key = speech ? settings.sttKey : settings.oaKey;
    if (!base) return { ok: false, error: 'No server address is set.' };
    const r = await getJson(`${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, deps, settings);
    if (!r.ok) return r;
    // Some servers answer { data: [...] }, a few answer a bare array.
    const rows = Array.isArray(r.json) ? r.json : r.json.data || r.json.models || [];
    return { ok: true, models: rows.map((m) => ({ id: typeof m === 'string' ? m : m.id || m.name })).filter((m) => m.id) };
  }
  if (provider === 'deepgram' || provider === 'sarvam') return { ok: false, error: NO_LIST };
  return { ok: false, error: `Unknown provider "${provider}".` };
}

// ---- cache: one list per provider and address for 6 hours; a failed fetch is never kept ----
const memo = new Map();
export const clearListCache = () => memo.clear();

const cacheKey = (provider, s) => `${provider}|${provider === 'openai' ? s.oaBase || '' : provider === 'openai-speech' ? s.sttBase || '' : ''}`;
const store = () => globalThis.chrome?.storage?.local;

export async function cachedList(provider, settings = {}, deps = {}) {
  const k = cacheKey(provider, settings);
  const now = (deps.now || Date.now)();
  const hit = memo.get(k);
  if (hit && now - hit.at < TTL) return { ok: true, models: hit.models, cached: true };
  try {
    const { modelLists = {} } = (await store()?.get('modelLists')) || {};
    const h = modelLists[k];
    if (h && now - h.at < TTL) {
      memo.set(k, h);
      return { ok: true, models: h.models, cached: true };
    }
  } catch {}
  const r = await listModels(provider, settings, deps);
  if (!r.ok) return r;
  const entry = { at: now, models: r.models }; // ids and labels only, no key
  memo.set(k, entry);
  try {
    const s = store();
    if (s) {
      const { modelLists = {} } = (await s.get('modelLists')) || {};
      await s.set({ modelLists: { ...modelLists, [k]: entry } });
    }
  } catch {}
  return r;
}

// ---- closest available id ----
const UNSTABLE = /preview|experimental|exp\b|-exp|latest|\d{4}-?\d{2}-?\d{2}|-\d{3,}$/;

// gemini-3.7-flash-lite -> { fam: 'gemini', ver: [3, 7], variant: 'flash-lite' }
function parse(id) {
  let m = /^gemini-(\d+)(?:\.(\d+))?-(.+)$/.exec(id);
  if (m) return { fam: 'gemini', ver: [+m[1], +(m[2] || 0)], variant: m[3].replace(/-(preview|exp|experimental|latest).*$|-\d{3,}.*$/, ''), unstable: UNSTABLE.test(m[3]) };
  m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(-\d{8})?$/.exec(id);
  if (m) return { fam: `claude-${m[1]}`, ver: [+m[2], +(m[3] || 0)], variant: '', unstable: !!m[4] };
  return null;
}
const newer = (a, b) => a[0] - b[0] || a[1] - b[1];

export function closest(id, available) {
  const want = parse(id);
  if (!want) return undefined;
  const pool = available
    .map((a) => ({ id: a, p: parse(a) }))
    .filter((x) => x.p && x.id !== id && x.p.fam === want.fam && x.p.variant === want.variant);
  const pick = (list) => list.sort((a, b) => newer(b.p.ver, a.p.ver) || a.id.length - b.id.length)[0]?.id;
  return pick(pool.filter((x) => !x.p.unstable)) || pick(pool);
}

// The fallback chain without the ids the provider does not have. The primary stays first even when unknown.
export function usableChain(models, available) {
  const ids = (available || []).map((m) => (typeof m === 'string' ? m : m.id));
  if (!ids.length) return models;
  return models.filter((m, i) => i === 0 || ids.includes(m));
}

const ROLE_NAME = { speech: 'Speech-to-text', minutes: 'Minutes', fallback: 'Backup' };
const WHOSE = { gemini: "your Google account's", anthropic: "your Anthropic account's", openai: "the server's", 'openai-speech': "the server's", deepgram: "the provider's", sarvam: "the provider's" };

// Every model the current settings would really use, checked against the provider's list.
export async function checkConfigured(settings, deps = {}) {
  const wanted = []; // { role, list, id }
  const sp = settings.sttProvider;
  if (sp === 'gemini' && settings.sttGeminiModel) wanted.push({ role: 'speech', list: 'gemini', id: settings.sttGeminiModel });
  else if (sp === 'sarvam' && settings.sarvamModel) wanted.push({ role: 'speech', list: 'sarvam', id: settings.sarvamModel });
  else if (sp === 'deepgram' && settings.deepgramModel) wanted.push({ role: 'speech', list: 'deepgram', id: settings.deepgramModel });
  else if (sp === 'openai' && settings.sttModel) wanted.push({ role: 'speech', list: 'openai-speech', id: settings.sttModel });
  const lp = settings.llmProvider;
  if (lp === 'gemini' && settings.geminiModel) {
    wanted.push({ role: 'minutes', list: 'gemini', id: settings.geminiModel });
    for (const id of modelChain(settings.geminiModel).slice(1)) wanted.push({ role: 'fallback', list: 'gemini', id });
  } else if (lp === 'anthropic' && settings.anthropicModel) wanted.push({ role: 'minutes', list: 'anthropic', id: settings.anthropicModel });
  else if (lp === 'openai' && settings.oaModel) wanted.push({ role: 'minutes', list: 'openai', id: settings.oaModel });

  const lists = {};
  for (const w of wanted) lists[w.list] ||= await cachedList(w.list, settings, deps);
  const out = [];
  for (const w of wanted) {
    const l = lists[w.list];
    const base = { role: w.role, provider: w.list === 'openai-speech' ? 'openai' : w.list, id: w.id };
    if (!l.ok) {
      if (w.role !== 'fallback') out.push({ ...base, state: 'unknown', detail: l.error });
      continue;
    }
    const ids = l.models.map((m) => m.id);
    if (ids.includes(w.id)) {
      if (w.role !== 'fallback') out.push({ ...base, state: 'ok', detail: 'Found in the provider\'s model list.' });
      continue;
    }
    const suggestion = closest(w.id, ids);
    out.push({ ...base, state: 'missing', ...(suggestion ? { suggestion } : {}), detail: `Not in ${WHOSE[w.list]} model list.${suggestion ? ` Closest available: "${suggestion}".` : ''}` });
  }
  return out;
}

// One plain-English line per model that is not there.
export function summary(findings) {
  return findings
    .filter((f) => f.state === 'missing')
    .map((f) => `${ROLE_NAME[f.role]} model "${f.id}" is not in ${WHOSE[f.provider]} model list.${f.suggestion ? ` Closest available: "${f.suggestion}".` : ''}`);
}
