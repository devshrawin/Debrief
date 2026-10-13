// Local API usage tracking. Debrief makes every call itself, so it can count them; Google does not
// expose remaining free quota, so "left today" is an estimate against limits learned from 429 replies
// or typed in by the user. Days roll over at midnight Pacific time, when Gemini's daily quota resets.

const FIELDS = ['req', 'fail', 'rl', 'tin', 'tout', 'audioSec'];

export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}

const rowKey = (e) => `${e.provider}|${e.model || '-'}|${e.kind}`;

// Pure: returns a new usage object with the entry added.
export function addEntry(usage, e, now = new Date()) {
  const next = { ...(usage || {}) };
  const day = dayKey(now);
  const rows = { ...(next[day] || {}) };
  const key = rowKey(e);
  const row = { req: 0, fail: 0, rl: 0, tin: 0, tout: 0, audioSec: 0, ...(rows[key] || {}) };
  row.req += e.req || 0;
  row.fail += e.fail ? 1 : 0;
  row.rl += e.rl ? 1 : 0;
  row.tin += e.tin || 0;
  row.tout += e.tout || 0;
  row.audioSec += e.audioSec || 0;
  rows[key] = row;
  next[day] = rows;
  // Keep about two months.
  const keep = new Date(now.getTime() - 62 * 86400000);
  for (const d of Object.keys(next)) if (d < dayKey(keep)) delete next[d];
  return next;
}

// Totals per provider/model/kind over the last `days` days (1 = today).
export function summarize(usage, days = 1, now = new Date()) {
  const out = {};
  for (let i = 0; i < days; i++) {
    const rows = (usage || {})[dayKey(new Date(now.getTime() - i * 86400000))] || {};
    for (const [key, r] of Object.entries(rows)) {
      const [provider, model, kind] = key.split('|');
      const t = (out[key] ||= { provider, model, kind, req: 0, fail: 0, rl: 0, tin: 0, tout: 0, audioSec: 0 });
      for (const f of FIELDS) t[f] += r[f] || 0;
    }
  }
  return Object.values(out).sort((a, b) => b.req - a.req);
}

// "limit: 20, model: gemini-3.8-flash" appears in Gemini quota errors.
export function learnLimit(text) {
  const s = String(text || '');
  const limit = Number((s.match(/limit:\s*(\d+)/i) || [])[1]);
  const model = (s.match(/model:\s*([\w.-]+)/i) || [])[1];
  return limit && model ? { model, limit } : null;
}

// User-entered limits, one "model=number" per line, override learned ones.
export function parseLimits(text) {
  const out = {};
  for (const line of String(text || '').split(/\n/)) {
    const m = line.match(/^\s*([\w.:-]+)\s*[=:]\s*(\d+)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// Models that are close to (or past) their daily request limit, for the popup warning.
export function nearLimit(usage, limits, now = new Date()) {
  const today = summarize(usage, 1, now);
  const hits = [];
  for (const r of today) {
    const limit = limits[r.model];
    if (!limit || r.kind === 'tokens') continue;
    const used = today.filter((x) => x.model === r.model).reduce((a, x) => a + x.req, 0);
    if (!hits.some((h) => h.model === r.model) && used >= Math.ceil(limit * 0.8)) hits.push({ model: r.model, used, limit });
  }
  return hits;
}

// Runs in any extension context. Pages without storage access (the offscreen document) and the
// service worker all funnel into the service worker so counts never race.
export const sink = { fn: null }; // tests replace this
export function record(entry) {
  try {
    if (sink.fn) return sink.fn(entry);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ target: 'bg', type: 'usage', entry }).catch(() => {});
    }
  } catch {}
}

// Estimated cost in USD from per-million-token prices the user can edit ("model=in,out" per line).
export function parsePrices(text) {
  const out = {};
  for (const line of String(text || '').split(/\n/)) {
    const m = line.match(/^\s*([\w.:-]+)\s*[=:]\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
    if (m) out[m[1]] = { in: Number(m[2]), out: Number(m[3]) };
  }
  return out;
}

export function estimateCost(rows, prices) {
  let total = 0;
  let priced = false;
  for (const r of rows) {
    const p = prices[r.model];
    if (!p) continue;
    priced = true;
    total += (r.tin / 1e6) * p.in + (r.tout / 1e6) * p.out;
  }
  return priced ? total : null;
}
