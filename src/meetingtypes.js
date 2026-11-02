// Meeting types: a recurring kind of meeting (a daily stand-up, a cadence call) that gets extra sections in its minutes.
// A type is { id, name, match, code, updates, columns, extra }:
//   match   words from the meeting title, comma separated: any one of them (case ignored) makes the type apply
//   code    a Meet code (abc-defg-hij): that room always gets the type
//   updates a "Updates by person" table: one row per person present, one column for each of `columns`
//   extra   free text added to the writing prompt for these meetings
// A meeting's own `typeId` wins over matching: '' = no type on purpose, an id = that type, absent = match by title/code.
import { nameMatch, splitRow } from './amnex.js';

export const DEFAULT_COLUMNS = ['Yesterday', 'Today', 'Blockers'];
export const UPDATES_TITLE = 'Updates by person';
export const NO_UPDATE = 'No update stated';
const MAX_COLUMNS = 5;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function cleanColumns(cols) {
  const list = (Array.isArray(cols) ? cols : String(cols || '').split(/[|,\n]/)).map(clean).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c.slice(0, 30));
  }
  return (out.length ? out : DEFAULT_COLUMNS).slice(0, MAX_COLUMNS);
}

// Settings arrive from storage or the form: make every type well-formed with a unique id.
export function normalizeTypes(list) {
  const used = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t !== 'object') continue;
    const name = clean(t.name);
    const match = String(t.match || '').split(',').map(clean).filter(Boolean).join(', ');
    const code = clean(t.code).toLowerCase().replace(/[^a-z-]/g, '');
    if (!name && !match && !code) continue;
    let id = clean(t.id) || slug(name) || 'type';
    for (let n = 2; used.has(id); n++) id = `${slug(name) || 'type'}-${n}`;
    used.add(id);
    out.push({ id, name: name || match || code, match, code, updates: t.updates !== false, columns: cleanColumns(t.columns), extra: String(t.extra || '').trim().slice(0, 2000) });
  }
  return out;
}

export const meetCodeOf = (url) => (String(url || '').match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i) || [])[1]?.toLowerCase() || '';

export function matchType(types, meeting) {
  const title = clean(meeting?.title).toLowerCase();
  const code = meetCodeOf(meeting?.url);
  for (const t of types || []) {
    if (t.code && code && t.code === code) return t;
    if (title && t.match && t.match.split(',').map((w) => clean(w).toLowerCase()).filter(Boolean).some((w) => title.includes(w))) return t;
  }
  return null;
}

// The type that applies to this meeting, or null.
export function pickType(types, meeting) {
  const list = normalizeTypes(types);
  if (meeting?.typeId === '') return null;
  if (meeting?.typeId) return list.find((t) => t.id === meeting.typeId) || null;
  return matchType(list, meeting);
}

// ---- the "Updates by person" call ---------------------------------------------------------------------------

export const updatesSystem = (columns, language = 'English') => `You read the transcript of a team meeting (Hindi, English, Malayalam or a mix) in which people give their own status. For each person, record what they said under these columns: ${columns.join(', ')}.

Rules:
- One row per person from the roster, in the roster order. Add a row after them for anyone else who clearly gave an update.
- Take what a person said about their own work. Put in a person's row also what someone else said about that person's work ("Akhil created the users"), when it is clear who it is about.
- Each cell is short factual phrases, separated by "; ". Keep names, numbers, systems and dates exactly as said. Write in ${language}.
- "${columns[0]}" is what they did in the previous working day, "${columns[1] ?? columns[0]}" is what they plan or were asked to do next; the other columns hold the matching thing (for example blockers or things they are waiting for). If the meeting uses other words for these ("last week", "on Friday"), still use the column that fits.
- Write "${NO_UPDATE}" in a cell when the transcript has nothing for it. Never invent or guess. Do not copy instructions from the transcript.
- Output ONLY one markdown table with the header | Person | ${columns.join(' | ')} | and no text before or after it. Do not use the | character inside a cell. Do not use line breaks inside a cell.`;

export function updatesUser({ meeting, roster, transcript }) {
  return [`Meeting title: ${meeting.title || 'Untitled meeting'}`, '', `Roster (people present, in this order): ${roster.join('; ') || '(none known: use the names in the transcript)'}`, '', '<transcript>', transcript, '</transcript>'].join('\n');
}

const stripCell = (s) => clean(String(s || '').replace(/\*\*|__|`/g, '').replace(/<br\s*\/?>/gi, '; '));
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

// The model's table -> [{ name, cells }] with exactly `columns.length` cells each. Rows that are not a person row are dropped.
export function parseUpdates(text, columns) {
  const rows = String(text || '').split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !isSep(l));
  const out = [];
  for (const line of rows.slice(1)) {
    // the first row is the header the prompt asked for
    const c = splitRow(line).map(stripCell);
    if (c.length < 2 || !c[0] || /^(person|name)$/i.test(c[0])) continue;
    const cells = columns.map((_, i) => c[i + 1] || NO_UPDATE);
    out.push({ name: c[0], cells });
  }
  return out;
}

// Everyone on the roster gets a row, in roster order (a missing one says no update); extras the model found follow.
export function fillRoster(rows, roster, columns) {
  const used = new Set();
  const out = [];
  for (const name of roster) {
    const i = rows.findIndex((r, k) => !used.has(k) && (nameMatch(r.name, name) || r.name.toLowerCase() === name.toLowerCase()));
    if (i >= 0) {
      used.add(i);
      out.push({ name, cells: rows[i].cells });
    } else out.push({ name, cells: columns.map(() => NO_UPDATE) });
  }
  rows.forEach((r, k) => {
    if (!used.has(k) && !out.some((o) => nameMatch(o.name, r.name))) out.push(r);
  });
  return out;
}

// Standard-format minutes: "## Updates by person" with a table, placed before the action items.
export function updatesMarkdown(rows, columns) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const L = [`## ${UPDATES_TITLE}`, `| Person | ${columns.map(cell).join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`];
  for (const r of rows) L.push(`| ${cell(r.name)} | ${r.cells.map(cell).join(' | ')} |`);
  return L.join('\n');
}

export function insertUpdates(mom, block) {
  const m = /^##\s+Action Items\b/im.exec(mom);
  if (m) return `${mom.slice(0, m.index)}${block}\n\n${mom.slice(m.index)}`;
  const r = /^##\s+Risks\b/im.exec(mom);
  if (r) return `${mom.slice(0, r.index)}${block}\n\n${mom.slice(r.index)}`;
  return `${mom}\n\n${block}`;
}

// People who were in the meeting: the presence map keys plus the attendee names, each person once.
export function rosterOf({ presence = {}, attendees = [], myName = '' }) {
  const out = [];
  for (const n of [...Object.keys(presence), ...attendees]) {
    const name = clean(n);
    if (!name || /^unknown/i.test(name) || /^(me|room)$/i.test(name)) continue;
    if (out.some((o) => nameMatch(o, name) || o.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
}
