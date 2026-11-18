// Pure logic for the minutes page extras and the Open actions page: no DOM, no storage, no chrome.*.
// Everything here is unit-tested in node (test/pro-momextras.mjs).
import { parseDue } from './actions.js';
import { segmentsFromUtterances } from './utter.js';

const DAY = 86400000;
const r1 = (x) => Math.round(x * 10) / 10;
const pad = (n) => String(n).padStart(2, '0');

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// "12:40" -> 760, "1:05:30" -> 3930, anything else -> null
export function clockToSec(text) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (ss > 59 || (m[1] !== undefined && mm > 59)) return null;
  return h * 3600 + mm * 60 + ss;
}

// seconds -> "mm:ss" or "h:mm:ss" (the transcript's own style)
export function clockText(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h ? `${h}:${pad(m)}` : pad(m)}:${pad(sec % 60)}`;
}

// Inline emphasis markers ("**bold**", "*italic*", "_x_", `code`) as plain text. Only markers that wrap a word are removed; the text is never turned into HTML.
export function plainInline(text) {
  return String(text ?? '')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(?=[^\s*_])(.+?)(?<=[^\s*_])\2(?=$|[\s).,;:!?])/g, '$1$3')
    .replace(/`([^`]+)`/g, '$1');
}

// ---- time references inside the minutes: "[12:40]" -------------------------------------------------------------

// Every "[mm:ss]" or "[h:mm:ss]" in a piece of text: where it is, how long it is, its label and its second.
export function timeTokens(text) {
  const out = [];
  const re = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
  let m;
  const s = String(text ?? '');
  while ((m = re.exec(s))) {
    const sec = clockToSec(m[1]);
    if (sec != null) out.push({ index: m.index, length: m[0].length, label: m[1], sec });
  }
  return out;
}

// ---- which row of the minutes' action table is which action ---------------------------------------------------

// Two texts are "the same action" when their letters and digits agree: Markdown marks, spacing and a trailing "(done)" do not count.
export const matchKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s*\(done\)\s*$/, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

// tables: [{ heading, rows: [[cell text, ...], ...] }] (body rows only). actions: meeting.items.actions.
// -> { table, col } for the table whose rows are exactly these actions, in order; null when none is (the minutes were edited by
// hand, or were written another way), so that no tick box is ever put on the wrong row.
export function matchActionTable(tables, actions) {
  if (!Array.isArray(actions) || !actions.length) return null;
  for (let t = 0; t < (tables || []).length; t++) {
    const tb = tables[t];
    if (/previous/i.test(tb.heading || '') || tb.rows.length !== actions.length) continue;
    const cols = Math.max(0, ...tb.rows.map((r) => r.length));
    for (let c = 0; c < cols; c++) {
      if (tb.rows.every((r, i) => matchKey(r[c]) === matchKey(actions[i]?.text))) return { table: t, col: c };
    }
  }
  return null;
}

export const actionCounts = (actions) => {
  const list = Array.isArray(actions) ? actions : [];
  const done = list.filter((a) => a?.status === 'done').length;
  return { open: list.length - done, done };
};

// ---- the Open actions page -------------------------------------------------------------------------------------

const dueDate = (a) => parseDue(a.due, a.date ?? Date.now());
export const isOverdue = (a, today = new Date()) => {
  if (a.status === 'done') return false;
  if (typeof a.overdue === 'boolean') return a.overdue;
  const d = dueDate(a);
  return !!d && d.getTime() < startOfDay(today);
};

// Overdue first, then the earliest due date, then the newest meeting, then the order in the meeting. Actions with no real
// date come after those with one.
export function sortActions(list, today = new Date()) {
  const key = (a) => ({ over: isOverdue(a, today) ? 0 : 1, due: dueDate(a)?.getTime() ?? Infinity, date: -(a.date || 0), at: (typeof a.at === 'string' ? clockToSec(a.at) : a.at) ?? 0 });
  return [...(list || [])]
    .map((a, i) => ({ a, i, k: key(a) }))
    .sort((x, y) => x.k.over - y.k.over || x.k.due - y.k.due || x.k.date - y.k.date || x.k.at - y.k.at || x.i - y.i)
    .map((x) => x.a);
}

// Owner or any word of the text or the meeting's title: every word typed must be found somewhere.
export function filterActions(list, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list || [];
  return (list || []).filter((a) => {
    const hay = `${a.text || ''} ${a.owner || ''} ${a.title || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function countActions(list, today = new Date()) {
  const open = (list || []).filter((a) => a.status !== 'done');
  return { open: open.length, overdue: open.filter((a) => isOverdue(a, today)).length, done: (list || []).length - open.length };
}

const NOT_STATED = 'Not stated';
const ownerKey = (o) => {
  const k = String(o ?? '').replace(/\s+/g, ' ').trim();
  return !k || /^(not stated|none|n\/a|-|—)$/i.test(k) ? NOT_STATED : k;
};

// mode: 'meeting' | 'owner' | 'due' -> [{ key, label, date?, items }]. Items inside a group are sorted as sortActions does.
export function groupActions(list, mode, today = new Date()) {
  const sorted = sortActions(list, today).map((a, i) => ({ a, i })).sort((x, y) => (x.a.status === 'done') - (y.a.status === 'done') || x.i - y.i).map((x) => x.a); // done ones after the open ones
  const groups = new Map();
  const put = (key, label, a, extra = {}) => {
    if (!groups.has(key)) groups.set(key, { key, label, ...extra, items: [] });
    groups.get(key).items.push(a);
  };
  if (mode === 'owner') {
    for (const a of sorted) {
      const o = ownerKey(a.owner);
      put(o.toLowerCase(), o, a);
    }
    const rank = (g) => (g.label === NOT_STATED ? 2 : /^team$/i.test(g.label) ? 1 : 0);
    return [...groups.values()].sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label, undefined, { sensitivity: 'base' }));
  }
  if (mode === 'due') {
    const start = startOfDay(today);
    const bucket = (a) => {
      if (a.status === 'done') return ['done', 'Done', 5];
      if (isOverdue(a, today)) return ['overdue', 'Overdue', 0];
      const d = dueDate(a);
      if (!d) return ['none', 'No date set', 4];
      const days = Math.round((d.getTime() - start) / DAY);
      if (days <= 0) return ['today', 'Today', 1];
      if (days <= 7) return ['week', 'In the next 7 days', 2];
      return ['later', 'Later', 3];
    };
    const order = new Map();
    for (const a of sorted) {
      const [k, label, n] = bucket(a);
      order.set(k, n);
      put(k, label, a);
    }
    return [...groups.values()].sort((x, y) => order.get(x.key) - order.get(y.key));
  }
  for (const a of sorted) put(a.meetingId, a.title || 'Untitled meeting', a, { date: a.date });
  return [...groups.values()].sort((x, y) => (y.date || 0) - (x.date || 0));
}

// Actions ticked off in the last `days` days, in the shape openActionsAcrossMeetings uses (status 'done', doneAt).
// metas: the meetings' META records. An action with no doneAt counts from its meeting's date.
export function recentDone(metas, { today = new Date(), days = 30 } = {}) {
  const since = today.getTime() - days * DAY;
  const out = [];
  for (const m of [...(metas || [])].sort((a, b) => (b?.startedAt || 0) - (a?.startedAt || 0))) {
    for (const a of Array.isArray(m?.items?.actions) ? m.items.actions : []) {
      if (!a || a.status !== 'done') continue;
      if ((a.doneAt ?? m.startedAt ?? 0) < since) continue;
      out.push({ meetingId: m.id, title: m.title || '', date: m.startedAt, id: a.id, text: a.text, owner: a.owner, due: a.due, at: a.at, status: 'done', doneAt: a.doneAt, overdue: false });
    }
  }
  return out;
}

// ---- reading a stretch of the recording again ---------------------------------------------------------------------

// What to cut from the recording for a transcript row: the piece the row came from (c..c+dur) when it says where that
// starts and how long it is, else a little before and after the row's own time. A gap is its own from..to.
export function rereadSpan(row) {
  if (row?.gap && Number.isFinite(row.gap.from) && Number.isFinite(row.gap.to)) return [Math.max(0, row.gap.from), row.gap.to];
  if (Number.isFinite(row?.c) && Number.isFinite(row?.dur) && row.dur > 0) return [Math.max(0, row.c), r1(row.c + row.dur)];
  const t = Number(row?.t) || 0;
  return [Math.max(0, r1(t - 5)), r1(t + 40)];
}

// A long stretch is read again in at most this many one-minute requests (the first 30 minutes of it).
export const MAX_REREAD_PARTS = 30;
// What the "Read this part again" dialog says before anything is sent. `to` is the end that will be read, `rawTo` the end asked for.
export function rereadNote(from, to, rawTo, requests, fmt = String) {
  const n = Math.max(1, requests);
  const base = `From ${fmt(from)} to ${fmt(to)}. The recording of this part is sent to your speech-to-text service again`;
  const sends = n === 1 ? ' (one request).' : ` (about ${n} requests, one for each minute).`;
  const cut = rawTo > to + 0.5 ? ` This part is longer than ${MAX_REREAD_PARTS} minutes, so only the first ${MAX_REREAD_PARTS} minutes are read.` : '';
  return `${base}${sends}${cut}`;
}

// [from, to] -> parts of at most partSec seconds, so one request never carries more than a speech service takes.
export function splitSpan(from, to, partSec = 60) {
  const out = [];
  for (let a = from; a < to - 0.05; a += partSec) out.push([r1(a), r1(Math.min(to, a + partSec))]);
  return out;
}

const TOL = 0.15; // seconds: times are stored to a tenth, so a line can sit a hair outside its own piece
export const inSpan = (t, from, to) => t >= from - TOL && t < to - TOL;

export const linesInSpan = (segs, from, to) => (segs || []).filter((s) => inSpan(Number(s.t), from, to));

// Results of several parts [{ at (absolute second the part starts), result: { text, utterances } }] -> utterances in seconds
// from `from`. A part the service answered without times becomes one utterance spanning that part.
export function mergeParts(parts, from, partEnd = (p) => p.at) {
  const out = [];
  for (const p of parts) {
    const shift = p.at - from;
    const r = p.result || {};
    if (r.utterances?.length) for (const u of r.utterances) out.push({ ...u, t0: u.t0 + shift, t1: u.t1 + shift });
    else if (String(r.text || '').trim()) out.push({ t0: shift, t1: partEnd(p) - from, text: String(r.text).trim() });
  }
  return out;
}

const sideOf = (l) => (l?.src === 'me' ? 'me' : 'others');
function nearestSrc(old, t, fallback) {
  let pick = null;
  for (const l of old) if (Number(l.t) <= t + 0.05) pick = l;
  return pick ? sideOf(pick) : old.length ? sideOf(old[0]) : fallback;
}

// The new lines for a stretch. A piece that was one side only (all you, or all the others) keeps that side. A piece that
// mixed both gives each new line the side of the old line nearest before it (the recording is one mixed stream, so the
// text alone cannot say). Lines carry c and dur of the stretch, so they can be read again, and reread: true.
export function freshLines({ utterances, text = '', from, to, old = [] }) {
  const sides = [...new Set(old.map(sideOf))];
  const base = sides.length === 1 ? sides[0] : 'others';
  let lines = utterances?.length ? segmentsFromUtterances(utterances, { t: from, src: base }) : String(text).trim() ? [{ t: r1(from), src: base, text: String(text).trim() }] : [];
  if (sides.length > 1) lines = lines.map((l) => ({ ...l, src: nearestSrc(old, l.t, base) }));
  return lines.map((l) => ({ ...l, c: r1(from), dur: r1(to - from), reread: true }));
}

// The transcript with the lines of one stretch swapped for new ones; everything else stays, in order.
export function replaceLines(segs, from, to, fresh) {
  const kept = (segs || []).filter((s) => !inSpan(Number(s.t), from, to));
  return [...kept, ...fresh].map((s, i) => ({ s, i })).sort((a, b) => a.s.t - b.s.t || a.i - b.i).map((x) => x.s);
}

// Gaps the recorder reported that this stretch now covers.
export const gapsOutside = (gaps, from, to) => (gaps || []).filter((g) => !(Number(g.t) < to && Number(g.t) + Number(g.dur || 0) > from));

// ---- the recording: which stored segment plays a second, and what follows it ----------------------------------------

// segs: [{ seq, t0, dur }] (metadata). The last segment that started at or before t and still reaches it (as audiokeep.segAt).
export function segFor(segs, t) {
  let hit = null;
  for (const s of [...(segs || [])].sort((a, b) => a.seq - b.seq)) if (s.t0 <= t && t < s.t0 + s.dur + 0.5) hit = s;
  return hit;
}

export const SEAM = 1.5; // seconds: a hole longer than this between two segments is a stretch that was not kept (paused)
// What comes after `cur`: { seg, offset } to carry on with, { gap: true } when nothing was kept for the next stretch, null at the end.
export function nextSeg(segs, cur) {
  const after = (segs || []).filter((s) => s.seq > cur.seq).sort((a, b) => a.seq - b.seq)[0];
  if (!after) return null;
  const end = cur.t0 + cur.dur;
  if (after.t0 - end > SEAM) return { gap: true };
  return { seg: after, offset: Math.max(0, end - after.t0) };
}

// The row playing at a given second: the last time at or before it. times must be sorted. -1 when before the first.
export function rowIndexAt(times, t) {
  let hit = -1;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= t + 0.05) hit = i;
    else break;
  }
  return hit;
}

// ---- notes about the shared screen -----------------------------------------------------------------------------------

// meeting.screens -> [{ t, presenter, text }] in time order, a note repeated straight after itself dropped.
export function screenRows(screens) {
  const out = [];
  let last = '';
  for (const n of [...(screens || [])].sort((a, b) => a.t - b.t)) {
    const text = String(n?.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.toLowerCase() === last) continue;
    last = text.toLowerCase();
    out.push({ t: Number(n.t) || 0, presenter: String(n.presenter || '').replace(/\s+/g, ' ').trim(), text });
  }
  return out;
}

// Transcript rows [{ t, ... }] plus the screen notes, in time order. A screen note goes before a spoken line at the same second.
export function withScreenRows(rows, screens) {
  const notes = screenRows(screens).map((n) => ({ t: n.t, src: 'screen', who: 'On screen', presenter: n.presenter, text: n.text, flag: '' }));
  return [...(rows || []), ...notes].map((r, i) => ({ r, i, s: r.src === 'screen' ? 0 : 1 })).sort((a, b) => a.r.t - b.r.t || a.s - b.s || a.i - b.i).map((x) => x.r);
}

// The text of the transcript file: the lines as formatTranscript wrote them, plus "[mm:ss] ON SCREEN (name): note" in place.
export function addScreenLines(lines, screens) {
  const notes = screenRows(screens);
  if (!notes.length) return lines;
  const out = [];
  let i = 0;
  const say = (n) => `[${clockText(n.t)}] ON SCREEN${n.presenter ? ` (${n.presenter})` : ''}: ${n.text}`;
  for (const line of lines) {
    const m = /^\[((?:\d+:)?\d{1,2}:\d{2})\]/.exec(line);
    const t = m ? clockToSec(m[1]) : null;
    if (t != null) while (i < notes.length && Math.floor(notes[i].t) <= t) out.push(say(notes[i++])); // a note shows before the lines of its own second, as on screen
    out.push(line);
  }
  while (i < notes.length) out.push(say(notes[i++]));
  return out;
}

// ---- file names ------------------------------------------------------------------------------------------------------

// "<title>-<yyyy-mm-dd>.<ext>" with nothing a file system dislikes in it.
export function safeFileName(title, startedAt, ext) {
  const day = Number.isFinite(startedAt) ? new Date(startedAt).toISOString().slice(0, 10) : 'undated';
  const clean = String(title || 'Meeting')
    .replace(/\s*[\\/:*?"<>|\u0000-\u001f]+\s*/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[\s-]+$/g, '')
    .slice(0, 80)
    .trim();
  return `${clean || 'Meeting'}-${day}.${String(ext).replace(/[^a-z0-9]/gi, '')}`;
}
