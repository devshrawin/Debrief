// Action items across a series of meetings. Pure logic: no storage, no UI (other code wires it to both).
// A "series" is the same recurring meeting. Its open action items are carried into the next meeting's minutes, where
// the model says which were reported done; the earlier meeting's items are then updated (applyReview).
// Items have the shape of src/structured.js: items.actions = [{ id, text, owner, due, at, quote, status, doneAt }].
import { meetCodeOf } from './meetingtypes.js';

const DAY = 86400000;
export const SERIES_WINDOW_DAYS = 60;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const GENERIC_TITLE = /^(untitled( meeting)?|meeting|new meeting|instant meeting|google meet|meet|call|zoom meeting|team meeting)$/;

// ---- which meetings belong together -------------------------------------------------------------

// The meeting type wins, then the Meet room, then the title without dates and numbers. null when nothing says it is
// a recurring meeting (a generic title such as "Untitled meeting" matches everything, so it matches nothing).
export function seriesKey(meeting, meetingType) {
  if (meetingType?.id) return `type:${meetingType.id}`;
  const code = meetCodeOf(meeting?.url);
  if (code) return `meet:${code}`;
  const title = String(meeting?.title || '')
    .toLowerCase()
    .replace(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\b`, 'g'), ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || GENERIC_TITLE.test(title)) return null;
  return `title:${title}`;
}

// The newest earlier meeting of the same series, at most SERIES_WINDOW_DAYS before this one. typeOf(meeting) -> type or null.
export function previousInSeries(meeting, metas, typeOf = () => null) {
  const key = seriesKey(meeting, typeOf(meeting));
  if (!key || !Number.isFinite(meeting?.startedAt)) return null;
  let best = null;
  let bestWithActions = null; // an earlier meeting with no actions has nothing to carry: the newest one that has some is preferred
  for (const m of metas || []) {
    if (!m || m.id === meeting.id || !Number.isFinite(m.startedAt) || m.startedAt >= meeting.startedAt) continue;
    if (meeting.startedAt - m.startedAt > SERIES_WINDOW_DAYS * DAY) continue;
    if (seriesKey(m, typeOf(m)) !== key) continue;
    if (!best || m.startedAt > best.startedAt) best = m;
    if (m.items?.actions?.length && (!bestWithActions || m.startedAt > bestWithActions.startedAt)) bestWithActions = m;
  }
  return bestWithActions || best;
}

export const openActions = (items) => (Array.isArray(items?.actions) ? items.actions : []).filter((a) => a && a.status !== 'done');

// ---- carrying them into the next minutes ----------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => {
  if (typeof d === 'number' && Number.isFinite(d)) {
    const x = new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }
  return String(d || '');
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// prevMeeting: { title, date | startedAt }, open: the open actions (each with id). Items are numbered 1..n: weak models
// can answer with a number more reliably than with an id, and both are accepted back (normalizeReview).
export function carryText(prevMeeting, open) {
  const list = (open || []).map((a, i) => `${i + 1}. [id: ${a.id}] ${oneLine(a.text)} (owner: ${oneLine(a.owner) || 'Not stated'}; due: ${oneLine(a.due) || 'Not stated'})`);
  return `Open action items from the previous meeting in this series (${oneLine(prevMeeting?.title) || 'earlier meeting'}, ${dateText(prevMeeting?.date ?? prevMeeting?.startedAt)}). For each, say in the minutes whether it was reported done, is still open, or was not mentioned:\n${list.join('\n')}`;
}

// "Done" | "Open" | "Not mentioned" in any wording a model might use -> 'done' | 'open' | 'not mentioned'
export function normStatus(s) {
  const t = String(s || '').toLowerCase();
  // the open and negative wordings first: "Incomplete" and "Partially done" contain "complete" and "done"
  if (/\b(un(resolved|finished|done)|incomplete|not\s+(yet\s+)?(done|complete|completed|finished|closed)|partial(ly)?|pending|to\s+be\s+(done|completed|finished)|open|in\s+progress|ongoing)\b/.test(t)) return 'open';
  if (/not\s+mention|no\s+mention|not\s+discussed|not\s+raised|unmention/.test(t)) return 'not mentioned';
  if (/done|complete|finished|closed|resolved/.test(t)) return 'done';
  if (/open|pending|progress|still|ongoing|blocked|delayed/.test(t)) return 'open';
  return 'not mentioned';
}
const LABEL = { done: 'Done', open: 'Open', 'not mentioned': 'Not mentioned' };

// What the model said about the carried actions -> [{ id, status, note }], only for ids that were actually supplied.
// An entry names its action by id, or by its number in the list that was sent.
export function normalizeReview(raw, open) {
  const byId = new Map((open || []).map((a) => [String(a.id).toLowerCase(), a.id]));
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const ref = oneLine(r.id ?? r.n ?? r.number ?? r['#']).replace(/^#/, '').toLowerCase();
    const id = byId.get(ref) || (/^\d+$/.test(ref) ? open?.[Number(ref) - 1]?.id : undefined);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, status: normStatus(r.status), note: oneLine(r.note ?? r.comment).slice(0, 300) });
  }
  return out;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

// "## Previous Action Items": every carried action with what the meeting said about it. Not reported = "Not mentioned".
export function reviewSection(prevOpen, statuses) {
  if (!prevOpen?.length) return '';
  const map = new Map((Array.isArray(statuses) ? statuses : Object.entries(statuses || {}).map(([id, status]) => ({ id, status }))).map((s) => [s.id, normStatus(s.status)]));
  const L = ['## Previous Action Items', '| # | Action | Owner | Due | Status |', '|---|--------|-------|-----|--------|'];
  prevOpen.forEach((a, i) => L.push(`| ${i + 1} | ${cell(a.text)} | ${cell(a.owner) || 'Not stated'} | ${cell(a.due) || 'Not stated'} | ${LABEL[map.get(a.id) || 'not mentioned']} |`));
  return L.join('\n');
}

// Classic engine: the model wrote the "## Previous Action Items" table itself, with the item number in the # column.
export function parseReview(md, open) {
  const m = /^##\s+Previous Action Items\s*$/im.exec(String(md || ''));
  if (!m || !open?.length) return [];
  const body = String(md).slice(m.index + m[0].length).split(/\r?\n/);
  const raw = [];
  for (const line of body) {
    if (/^#{1,3}\s/.test(line)) break;
    if (!line.trim().startsWith('|') || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
    const c = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((x) => x.trim());
    if (c.length < 2 || /^#$|^no\.?$/i.test(c[0])) continue;
    raw.push({ id: c[0].replace(/\*/g, ''), status: c[c.length - 1] });
  }
  return normalizeReview(raw, open);
}

// A copy of the previous meeting's items with the actions reported done marked done (so the earlier meeting can be updated).
export function applyReview(prevItems, statuses, now = Date.now()) {
  const list = Array.isArray(statuses) ? statuses : Object.entries(statuses || {}).map(([id, status]) => ({ id, status }));
  const done = new Set(list.filter((s) => normStatus(s.status) === 'done').map((s) => s.id));
  return { ...prevItems, actions: (prevItems?.actions || []).map((a) => (done.has(a.id) && a.status !== 'done' ? { ...a, status: 'done', doneAt: now } : { ...a })) };
}

// ---- the tracker view ----------------------------------------------------------------------------

// "2026-10-16", "16-Oct-26", "16 Oct", "Oct 16, 2026", "16/10/2026" (day first) -> a Date at local midnight, else null.
// A date without a year takes the year of the meeting it came from (the next year if that would be long before it).
export function parseDue(text, refMs = Date.now()) {
  const t = String(text || '').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const ref = new Date(refMs);
  const month = (w) => MONTHS.indexOf(String(w).slice(0, 3));
  let y, mo, d, m;
  if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t))) [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  else if ((m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/.exec(t))) [y, mo, d] = [+m[3], +m[2] - 1, +m[1]];
  else if ((m = /\b(\d{1,2})[ -]([a-z]{3,9})(?:[ -](\d{2,4}))?\b/.exec(t)) && month(m[2]) >= 0 && MONTHS.includes(m[2].slice(0, 3))) [y, mo, d] = [m[3] ? +m[3] : undefined, month(m[2]), +m[1]];
  else if ((m = /\b([a-z]{3,9}) (\d{1,2})(?: (\d{2,4}))?\b/.exec(t)) && MONTHS.includes(m[1].slice(0, 3))) [y, mo, d] = [m[3] ? +m[3] : undefined, month(m[1]), +m[2]];
  else return null;
  if (y !== undefined && y < 100) y += 2000;
  const make = (yy) => new Date(yy, mo, d);
  let out = make(y ?? ref.getFullYear());
  if (y === undefined && out.getTime() < ref.getTime() - 30 * DAY) out = make(ref.getFullYear() + 1);
  return out.getMonth() === mo && out.getDate() === d ? out : null;
}

// Every open action of every meeting, newest meeting first. `overdue` when the due date is before today.
export function allOpenActions(meetings, { today = new Date() } = {}) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const out = [];
  for (const m of [...(meetings || [])].sort((a, b) => (b?.startedAt || 0) - (a?.startedAt || 0))) {
    for (const a of openActions(m?.items)) {
      const due = parseDue(a.due, m.startedAt);
      out.push({ meetingId: m.id, title: m.title || '', date: m.startedAt, id: a.id, text: a.text, owner: a.owner, due: a.due, at: a.at, status: a.status || 'open', overdue: !!due && due.getTime() < start });
    }
  }
  return out;
}

// A new items object with one action's status changed ('done' stamps doneAt, 'open' clears it).
export function setActionStatus(items, id, status, now = Date.now()) {
  return {
    ...items,
    actions: (items?.actions || []).map((a) => {
      if (a.id !== id) return { ...a };
      const next = { ...a, status };
      if (status === 'done') next.doneAt = now;
      else delete next.doneAt;
      return next;
    }),
  };
}

// Ticks made while the model was writing win over the copy read when the job started (matched by action id).
export function keepStatuses(items, current) {
  if (!items?.actions || !current?.actions?.length) return items;
  const now = new Map(current.actions.filter((a) => a?.id).map((a) => [a.id, a]));
  const actions = items.actions.map((a) => {
    const c = now.get(a.id);
    if (!c) return a;
    const { status: _s, doneAt: _a, doneBy: _b, ...rest } = a;
    return { ...rest, status: c.status || 'open', ...(c.doneAt != null ? { doneAt: c.doneAt } : {}), ...(c.doneBy != null ? { doneBy: c.doneBy } : {}) };
  });
  return { ...items, actions };
}

// The items after a review: actions reported done become done (doneBy = the meeting that closed them). null = nothing changes.
export function reviewItems(items, done, byId) {
  const before = items?.actions || [];
  const next = applyReview(items, done);
  const was = new Map(before.map((a) => [a.id, a.status]));
  next.actions = next.actions.map((a) => (a.status === 'done' && was.get(a.id) !== 'done' ? { ...a, doneBy: byId } : a));
  return next.actions.some((a, i) => a.status !== before[i]?.status) ? next : null;
}

// The items after one action is ticked or reopened (a person reopening it is no longer "closed by a meeting"). null = no such action.
export function tickItems(items, actionId, done) {
  if (!items?.actions?.some((a) => a.id === actionId)) return null;
  const next = setActionStatus(items, actionId, done ? 'done' : 'open');
  if (!done) next.actions = next.actions.map((a) => { if (a.id !== actionId) return a; const { doneBy: _b, ...rest } = a; return rest; });
  return next;
}
