// Optional webhook: when the minutes are written, the structured minutes are POSTed to the address the person gave.
// What leaves the browser is the minutes only: no transcript (not even the short quotes the minutes page shows as
// sources), no email addresses, no voice data, no keys.
//
// Whether the address may be called is decided where chrome.permissions exists: the service worker or Debrief's own
// pages. The offscreen document that runs the minutes job has no permissions API, so it asks the service worker
// ('webhook-post' with the meeting id only) and the worker loads the meeting and the settings itself.
import { renderMinutes } from './structured.js';

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
    minutesMarkdown: scrub(minutesForHook(m)),
  };
}

// ---- the minutes without the transcript quotes ----
const STAMP = /\[(?:\d+:)?\d{1,2}:\d{2}\]/g;
const SOURCE_HEAD = /^(source|sources|evidence|quote|quotes|source quote)$/i;
// one Markdown table row as raw cells (an escaped \| stays inside its cell)
function rawCells(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (line[i] === '|') {
      out.push(cur);
      cur = '';
    } else cur += line[i];
  }
  out.push(cur);
  return out;
}
const isSep = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
// "[12:40] \"we will ship\"" or "[12:40] — “we will ship”" -> "[12:40]"
const QUOTE_AFTER_STAMP = /(\[(?:\d+:)?\d{1,2}:\d{2}\])\s*[-–—:]?\s*(?:"[^"\n]*"|“[^”\n]*”|«[^»\n]*»)/g;

// The stored minutes with the transcript quotes taken out: in a table with a Source column only the [mm:ss] stamps of
// that column stay (or a dash), and a quote right after a stamp (the Decisions list) goes. Everything else is kept.
export function withoutQuotes(md) {
  const lines = String(md || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (!head.includes('|') || !isSep(lines[i + 1] || '')) {
      lines[i] = head.replace(QUOTE_AFTER_STAMP, '$1');
      continue;
    }
    const col = rawCells(head).findIndex((c) => SOURCE_HEAD.test(c.replace(/[*_`]/g, '').trim()));
    let j = i + 2;
    for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) {
      if (col < 0) {
        lines[j] = lines[j].replace(QUOTE_AFTER_STAMP, '$1');
        continue;
      }
      const cells = rawCells(lines[j]);
      if (col >= cells.length) continue;
      const stamps = cells[col].match(STAMP);
      cells[col] = ` ${stamps ? stamps.join(' ') : '—'} `;
      lines[j] = cells.join('|');
    }
    i = j - 1;
  }
  return lines.join('\n');
}

// The Markdown that is sent: the stored minutes (they may carry sections the items do not, and the person's edits)
// without quotes; minutes that exist only as items are rendered without the Source column.
function minutesForHook(m) {
  if (String(m.mom || '').trim()) return withoutQuotes(m.mom);
  if (m.items && typeof m.items === 'object') {
    try {
      return renderMinutes(m.items, { meeting: m, evidence: false });
    } catch {
      return '';
    }
  }
  return '';
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
const NO_WORKER = 'Debrief could not reach its background worker to send the minutes. Press Rewrite minutes to try again.';

// True only when Chrome says yes. No permissions API, an error or anything but true means no.
export async function hookPermitted(url, contains) {
  let origin;
  try {
    origin = new URL(String(url).trim()).origin;
  } catch {
    return false;
  }
  if (typeof contains !== 'function') return false;
  try {
    return (await contains({ origins: [`${origin}/*`] })) === true;
  } catch {
    return false;
  }
}

// Checks the address and Chrome's permission for it, then posts. For the service worker and Debrief's own pages
// (opts.contains replaces chrome.permissions.contains in a test). Never throws.
export async function postIfPermitted(meeting, settings, opts = {}) {
  if (!validWebhook(settings?.webhookUrl)) return { ok: false, status: 0, error: 'The webhook address is not valid. Use an https:// address without a user name or password.' };
  const p = globalThis.chrome?.permissions;
  const contains = opts.contains || (typeof p?.contains === 'function' ? (q) => p.contains(q) : null);
  if (!(await hookPermitted(settings.webhookUrl, contains))) return { ok: false, status: 0, error: NO_PERMISSION };
  return postWebhook(meeting, settings, opts);
}

// What came back from the worker, in a known shape.
const answerOf = (r) => (r && typeof r === 'object' && typeof r.ok === 'boolean' ? (r.ok ? { ok: true, status: Number(r.status) || 0 } : { ok: false, status: Number(r.status) || 0, error: String(r.error || NO_WORKER).slice(0, 300) }) : { ok: false, status: 0, error: NO_WORKER });

// The pipeline's step: the post (decided where permissions can be checked) and the result written on the meeting
// through patch (META only). Never throws.
//  - chrome.permissions here (service worker, an own page) or opts.contains (a test): checked and posted here;
//  - the offscreen document (no permissions API): the worker is asked to do it, by meeting id only;
//  - no messaging either: nothing is sent, except outside the browser altogether (no chrome.runtime: unit tests).
export async function runWebhook(meeting, settings, patch, opts = {}) {
  try {
    if (!validWebhook(settings?.webhookUrl)) return null;
    const c = globalThis.chrome;
    let r;
    if (opts.contains || typeof c?.permissions?.contains === 'function') r = await postIfPermitted(meeting, settings, opts);
    else if (typeof c?.runtime?.sendMessage === 'function' && typeof meeting?.id === 'string') {
      let answer = null;
      try {
        answer = await c.runtime.sendMessage({ target: 'bg', type: 'webhook-post', meetingId: meeting.id });
      } catch {}
      r = answerOf(answer);
    } else if (!c?.runtime) r = await postWebhook(meeting, settings, opts);
    else r = { ok: false, status: 0, error: NO_PERMISSION };
    await patch(r.ok ? { webhookAt: Date.now(), webhookError: null } : { webhookError: r.error });
    return r;
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}
