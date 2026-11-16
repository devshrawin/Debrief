// Optional webhook: when the minutes are written, the structured minutes are POSTed to the address the person gave.
// What leaves the browser is the minutes only: no transcript, no email addresses, no voice data, no keys.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// "Amal (amal@x.com)" -> "Amal"; a bare address -> a placeholder
const scrub = (s) => String(s ?? '').replace(/\s*[(<\[]\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*[)>\]]/g, '').replace(EMAIL, '[email hidden]');

// A copy of the items with every string scrubbed and the transcript excerpts (quote) left out.
function cleanItems(v) {
  if (Array.isArray(v)) return v.map(cleanItems);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'quote').map(([k, x]) => [k, cleanItems(x)]));
  return typeof v === 'string' ? scrub(v) : v;
}

export function webhookPayload(meeting, { settings } = {}) {
  const m = meeting || {};
  const mins = Number.isFinite(m.startedAt) && Number.isFinite(m.endedAt) ? Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000)) : null;
  return {
    app: 'debrief',
    version: 1,
    event: 'minutes.written',
    meeting: {
      id: m.id,
      title: scrub(m.title),
      startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null,
      durationMin: mins,
      attendees: (m.attendees || []).map(scrub).map((n) => n.trim()).filter(Boolean),
      format: m.format || 'standard',
    },
    items: m.items ? cleanItems(m.items) : null,
    minutesMarkdown: scrub(m.mom || ''),
  };
}

// https only (http for a program on this computer), no user:password in the address, not absurdly long.
export function validWebhook(url) {
  const s = String(url || '').trim();
  if (!s || s.length >= 2000) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

const isChatHook = (url) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'hooks.slack.com' || h.includes('.webhook.office.com') || h === 'outlook.office.com' || h.endsWith('.outlook.office.com');
  } catch {
    return false;
  }
};

const line = (s) => scrub(s).replace(/\s+/g, ' ').trim();
const CAP = 3500;

// Slack and Teams incoming webhooks take { text }: a short plain-text digest of the minutes.
export function chatDigest(meeting) {
  const m = meeting || {};
  const it = m.items || {};
  const when = Number.isFinite(m.startedAt) ? new Date(m.startedAt).toISOString().slice(0, 10) : '';
  const L = [`Minutes: ${line(m.title) || 'Meeting'}${when ? ` (${when})` : ''}`];
  if (it.overview) L.push('', line(it.overview));
  const decisions = (it.decisions || []).map((d) => line(d.text)).filter(Boolean);
  if (decisions.length) L.push('', 'Decisions:', ...decisions.map((d) => `- ${d}`));
  const actions = (it.actions || []).filter((a) => a && a.status !== 'done');
  if (actions.length) L.push('', 'Action items:', ...actions.map((a) => `- ${line(a.text)} (owner: ${line(a.owner) || 'not stated'}; due: ${line(a.due) || 'not stated'})`));
  const text = L.join('\n');
  return text.length > CAP ? `${text.slice(0, CAP - 1)}…` : text;
}

// POSTs the minutes. Never throws: { ok, status, error? }. One retry after 2 s on a network error or a 5xx.
export async function postWebhook(meeting, settings, { fetch: f = globalThis.fetch, timeoutMs = 10000, retryMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const url = String(settings?.webhookUrl || '').trim();
  if (!validWebhook(url)) return { ok: false, status: 0, error: 'The webhook address is not valid. Use an https:// address without a user name or password.' };
  const body = JSON.stringify(isChatHook(url) ? { text: chatDigest(meeting) } : webhookPayload(meeting, { settings }));
  let last = { ok: false, status: 0, error: 'No answer.' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(retryMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'omit', redirect: 'error', signal: ctl.signal });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: `The webhook answered HTTP ${res.status}.` };
      if (res.status < 500) return last; // the receiver said no: asking again will not change that
    } catch (e) {
      last = { ok: false, status: 0, error: ctl.signal.aborted ? `The webhook did not answer in ${Math.round(timeoutMs / 1000)} s.` : `Could not reach the webhook (${e?.message || e}).` };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

export const NO_PERMISSION = 'Debrief has no permission for this address. Open Settings and save the webhook again.';

// The pipeline's step: permission check, post, and the result written on the meeting through patch (META only).
// Never throws. The offscreen document has no chrome.permissions: then the fetch is simply tried.
export async function runWebhook(meeting, settings, patch, opts = {}) {
  try {
    if (!validWebhook(settings?.webhookUrl)) return null;
    const c = typeof chrome !== 'undefined' ? chrome.permissions : null;
    if (c?.contains) {
      let has = true;
      try {
        has = await c.contains({ origins: [`${new URL(String(settings.webhookUrl).trim()).origin}/*`] });
      } catch {}
      if (!has) {
        await patch({ webhookError: NO_PERMISSION });
        return { ok: false, status: 0, error: NO_PERMISSION };
      }
    }
    const r = await postWebhook(meeting, settings, opts);
    await patch(r.ok ? { webhookAt: Date.now(), webhookError: null } : { webhookError: r.error });
    return r;
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}
