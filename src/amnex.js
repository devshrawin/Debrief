// The official Amnex minutes format. Everything here is pure (no DOM, no chrome.*), so it is unit-tested.
//
// Who writes what:
//   CODE   builds the facts: header block (topic, mode, location, date, time, chairperson) and the two attendee
//          tables, from the meeting record, the calendar invite, who was seen or heard, and a saved directory.
//   MODEL  writes only the parts that need language: Agenda, Discussion rows, Action items, Next meeting. It is
//          asked for a strict markdown shape (parseModelOutput) and its Responsibility column is checked against
//          the people and organisations code knows (cleanResponsibility), so it cannot invent an owner.
//   The finished minutes are stored as ONE markdown string (composeMarkdown), tagged with a marker comment, so
//   Edit, Ask, Copy and .md keep working; parseAmnexMarkdown reads it back into the document that is rendered.
import { matchPeople, personLabel } from './attendance.js';
import { escapeHtml, renderMd } from './md.js';

export const MARKER = '<!-- debrief-format: amnex -->';

// ---- the organisation template: whose name, footer line and colour the official format carries ----
// Nothing here is Amnex-specific by default. AMNEX_PRESET (a button in Settings) fills in the Amnex values.
export const AMNEX_PRESET = { orgName: 'Amnex Infotechnologies', orgConfidential: 'Amnex Infotechnologies Pvt Ltd | Confidential', orgAccent: '#0c2461', myOrgDomains: 'amnex.com' };
const GENERIC_ACCENT = '#334155';
let ORG = { name: '', confidential: 'Confidential', accent: GENERIC_ACCENT, domains: [] };
export function setOrg(settings = {}) {
  ORG = {
    name: String(settings.orgName || '').trim(),
    confidential: String(settings.orgConfidential || '').trim() || 'Confidential',
    accent: /^#[0-9a-f]{6}$/i.test(String(settings.orgAccent || '').trim()) ? settings.orgAccent.trim() : GENERIC_ACCENT,
    domains: parseDomains(settings.myOrgDomains),
  };
}
export const getOrg = () => ORG;
// The big title uses a slightly lighter shade of the preset's navy; any other accent is used as it is.
const titleColor = () => (ORG.accent.toLowerCase() === '#0c2461' ? '#0c2d6b' : ORG.accent);
export const TBD = 'To be decided and communicated separately';
export const PH = {
  designation: '[DESIGNATION]',
  department: '[DEPARTMENT]',
  client: '[CLIENT]',
  chair: '[CHAIRPERSON]',
  location: '[LOCATION]',
  resp: '[RESPONSIBILITY]',
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

// ---- header facts -------------------------------------------------------------------------------

// 13-Oct-26 (the viewer's local calendar day).
export function fmtDate(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  return `${pad(d.getDate())}-${MON[d.getMonth()]}-${pad(d.getFullYear() % 100)}`;
}

// 10:00 AM, 12-hour.
export function fmtTime12(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const h = d.getHours();
  return `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

const APPS = [
  [/(^|\.)meet\.google\.com$/i, 'Google Meet'],
  [/(^|\.)zoom\.us$/i, 'Zoom'],
  [/(^|\.)teams\.(microsoft|live)\.com$/i, 'Microsoft Teams'],
  [/(^|\.)webex\.com$/i, 'Webex'],
  [/(^|\.)whereby\.com$/i, 'Whereby'],
  [/(^|\.)gotomeeting\.com$/i, 'GoToMeeting'],
];

// "Online (Google Meet)" from the meeting link, or "Offline" when there was no link (a room recording).
export function modeOf(url) {
  let host = '';
  try {
    const u = new URL(String(url || ''));
    if (/^https?:$/.test(u.protocol)) host = u.hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (!host) return 'Offline';
  const app = APPS.find(([re]) => re.test(host));
  return `Online (${app ? app[1] : host.replace(/^www\./, '')})`;
}
export const isOnline = (mode) => /^online/i.test(mode || '');

// ---- names and the directory ----------------------------------------------------------------------

const HONORIFICS = new Set(['sri', 'shri', 'smt', 'shrimati', 'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'kumari', 'km']);
const normTokens = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.has(t));
const normName = (s) => normTokens(s).join(' ');

// "sri" -> "Sri.", "DR" -> "Dr.": a bare known honorific gets its full stop, anything else is kept as typed.
export function tidyHonorific(h) {
  const t = String(h || '').trim();
  if (!t) return '';
  const w = t.replace(/\.$/, '');
  return HONORIFICS.has(w.toLowerCase()) ? `${w[0].toUpperCase()}${w.slice(1).toLowerCase()}.` : t;
}

// One person per line: Name | Honorific | Department | Designation | Organisation [| Chair]
// '#' starts a comment. Missing fields stay empty (the document then shows the [PLACEHOLDER]).
export function parseDirectory(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('|').map((x) => x.trim());
    if (!p[0]) continue;
    out.push({
      name: p[0],
      honorific: tidyHonorific(p[1]),
      department: p[2] || '',
      designation: p[3] || '',
      organisation: p[4] || '',
      chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || ''),
    });
  }
  return out;
}

// Are two spellings plausibly the same person? 1 = same name, 0.6 = first name only on one side, 0 = no.
export function nameMatch(a, b) {
  const ta = normTokens(a);
  const tb = normTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  if (ta[0] !== tb[0]) return 0;
  if (ta.length === 1 || tb.length === 1) return 0.6;
  // "Suresh K." vs "Suresh Kumar": every later word of one is a prefix of a word of the other.
  const rest = (x, y) => x.slice(1).every((w) => y.slice(1).some((v) => v === w || v.startsWith(w) || w.startsWith(v)));
  return rest(ta, tb) || rest(tb, ta) ? 0.9 : 0;
}

// The one directory entry for this name, or null (also null when a bare first name fits several people).
export function findPerson(dir, name) {
  if (!name) return null;
  const scored = (dir || []).map((p) => ({ p, s: nameMatch(p.name, name) })).filter((x) => x.s > 0);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s === best);
  return top.length === 1 ? top[0].p : null;
}

export const displayName = (name, entry) => {
  const base = entry?.name || name;
  return entry?.honorific ? `${entry.honorific} ${base}` : base;
};

// ---- who is on our side ---------------------------------------------------------------------------

const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton|protonmail|rediffmail)\./i;

export const parseDomains = (text) =>
  [...new Set(String(text || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];

// The System Integrator's email domains: the setting, else the domain of the user's own address when it is a
// company one, else none (then everyone goes into one attendee list: a split would be a guess).
export function myDomains(settings) {
  const set = parseDomains(settings?.myOrgDomains);
  if (set.length) return set;
  const first = String(settings?.emailTo || '').split(/[\s,;]+/).find((a) => a.includes('@'));
  const d = first ? first.split('@')[1].toLowerCase() : '';
  return d && !FREE_MAIL.test(d) ? [d] : [];
}

const inDomains = (email, domains) => {
  const d = String(email || '').split('@')[1]?.toLowerCase();
  return !!d && domains.some((x) => d === x || d.endsWith(`.${x}`));
};

// 'si' | 'client' | 'unknown'
export function sideOf({ email, org }, domains) {
  if (email) return inDomains(email, domains) ? 'si' : 'client';
  if (org) {
    const o = normName(org).replace(/\s+/g, '');
    return domains.some((d) => o.includes(d.split('.')[0].replace(/[^a-z0-9]/g, ''))) ? 'si' : 'client';
  }
  return 'unknown';
}

// One of our own domains -> the organisation name (Settings); other domains -> their first label, capitalised.
export function orgFromDomain(domain) {
  const label = String(domain || '').split('.')[0];
  if (!label) return '';
  if (ORG.name && ORG.domains.includes(String(domain).toLowerCase())) return ORG.name;
  return label[0].toUpperCase() + label.slice(1);
}

// ---- attendees ------------------------------------------------------------------------------------

// meeting: { title, url, startedAt, invited, attendees }, presence: { name: [first, last, n] } merged from the
// call page and from voices. Returns the two (or one) attendee groups plus the names and organisations that
// later validate the model's Responsibility column.
export function buildAttendees({ meeting, settings = {}, dir = [], presence = {}, entries = [] }) {
  const myName = settings.myName || '';
  const notes = [];
  const people = [];
  const add = (name, email = '') => {
    name = String(name || '').trim();
    if (!name) return;
    const dupe = people.find((p) => nameMatch(p.name, name) > 0 && !(p.email && email && p.email.toLowerCase() !== email.toLowerCase()));
    if (dupe) {
      if (normTokens(name).length > normTokens(dupe.name).length) dupe.name = name;
      if (email && !dupe.email) dupe.email = email;
      return;
    }
    people.push({ name, email });
  };

  const { rows, uninvited } = matchPeople(meeting?.invited || [], presence, { entries, myName });
  const hasPresence = Object.keys(presence || {}).length > 0;
  rows.filter((r) => r.present).forEach((r) => add(r.present.name || r.name, r.email));
  for (const u of uninvited) {
    if (/^you$/i.test(u.name.trim())) continue; // "You" is the note-taker, added below by name
    add(u.name);
  }
  (meeting?.attendees || []).forEach((n) => add(n)); // names the note-taker typed in
  const absent = rows.filter((r) => !r.present && r.name && !(myName && nameMatch(r.name, myName) > 0)).map((r) => r.name);
  if (hasPresence && absent.length) notes.push(`Invited but not seen in the meeting (so not listed above): ${absent.join(', ')}.`);
  if (!people.length && rows.length && !hasPresence) {
    rows.forEach((r) => add(r.name, r.email));
    notes.push('Who attended could not be read from the meeting, so the people invited are listed. Check this list before circulating.');
  }
  // the note-taker is running the recording, so they were there
  if (myName) add(myName, (meeting?.invited || []).find((p) => p.status === 'owner')?.email || '');

  const domains = myDomains(settings);
  const split = domains.length > 0;
  const info = people.map((p) => {
    const entry = findPerson(dir, p.name);
    return { name: displayName(p.name, entry), entry, email: p.email, side: split ? sideOf({ email: p.email, org: entry?.organisation }, domains) : 'all' };
  });

  const mode = (arr) => {
    const c = new Map();
    arr.filter(Boolean).forEach((x) => c.set(x, (c.get(x) || 0) + 1));
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const row = (p, kind, siOrg) => ({
    name: p.name,
    a: kind === 'client' ? p.entry?.department || PH.department : p.entry?.organisation || (kind === 'si' ? siOrg : PH.client),
    desig: p.entry?.designation || PH.designation,
  });

  let groups;
  const orgs = [];
  if (!split) {
    groups = [{ kind: 'all', org: '', rows: info.map((p) => row(p, 'all', '')) }];
    info.forEach((p) => p.entry?.organisation && orgs.push(p.entry.organisation));
  } else {
    const si = info.filter((p) => p.side === 'si');
    const client = info.filter((p) => p.side !== 'si');
    const unknown = info.filter((p) => p.side === 'unknown').map((p) => p.name);
    if (unknown.length) notes.push(`Which side these people belong to could not be told (no email or directory entry), so they are listed under Client Side: ${unknown.join(', ')}.`);
    const siOrg = mode(si.map((p) => p.entry?.organisation)) || orgFromDomain(domains[0]);
    const clientOrgs = [...new Set(client.map((p) => p.entry?.organisation).filter(Boolean))];
    const clientOrg = clientOrgs.length === 1 ? clientOrgs[0] : PH.client;
    groups = [
      { kind: 'client', org: clientOrg, rows: client.map((p) => row(p, 'client', siOrg)) },
      { kind: 'si', org: siOrg, rows: si.map((p) => row(p, 'si', siOrg)) },
    ];
    orgs.push(siOrg, ...clientOrgs);
    if (clientOrg !== PH.client) orgs.push(clientOrg);
  }
  return { groups, notes, people: info, orgs: [...new Set(orgs.filter(Boolean))] };
}

// ---- header ---------------------------------------------------------------------------------------

// An explicit "Chairperson: Name" line in the note-taker's context beats the directory.
export function chairFromNotes(notes) {
  const m = String(notes || '').match(/^\s*chair(?:person|man|woman)?\s*(?:was|is)?\s*[:\-–]\s*(.+?)\s*$/im);
  return m ? m[1].replace(/\s*\(.*?\)\s*$/, '').trim() : '';
}

export function resolveChair({ notes = '', dir = [], people = [] }) {
  let name = chairFromNotes(notes);
  let entry = name ? findPerson(dir, name) : null;
  if (!name) {
    // a directory person flagged as chair who was in the meeting
    const flagged = dir.filter((d) => d.chair && people.some((p) => nameMatch(p.entry?.name || p.name, d.name) > 0));
    if (flagged.length === 1) {
      entry = flagged[0];
      name = entry.name;
    }
  }
  if (!name) return PH.chair;
  return [displayName(name, entry), entry?.designation || PH.designation, entry?.organisation || PH.client].join(', ');
}

// All the facts of the document, from code alone.
export function buildFacts({ meeting, settings = {}, dir = [], presence = {}, entries = [], notes = '' }) {
  const att = buildAttendees({ meeting, settings, dir, presence, entries });
  const mode = modeOf(meeting?.url);
  return {
    title: meeting?.title || 'Meeting',
    header: {
      topic: meeting?.title || 'Meeting',
      mode,
      location: isOnline(mode) ? '—' : PH.location,
      date: fmtDate(meeting?.startedAt),
      time: fmtTime12(meeting?.startedAt),
      chair: resolveChair({ notes, dir, people: att.people }),
    },
    groups: att.groups,
    notes: att.notes,
    known: { people: att.people.map((p) => p.name), orgs: att.orgs },
  };
}

// ---- Responsibility guard ---------------------------------------------------------------------------

// Everyone the code can vouch for: attendees, invitees, directory people, and the organisations.
export function knownParties({ facts, meeting, dir = [], transcript = '' }) {
  // attendees, invitees and typed names, each in the directory's spelling (with honorific) when it has one
  const names = [];
  const add = (n) => {
    n = String(n || '').trim();
    if (!n) return;
    const shown = displayName(n, findPerson(dir, n));
    const i = names.findIndex((x) => normName(x) === normName(shown));
    if (i < 0) names.push(shown);
    else if (shown.length > names[i].length) names[i] = shown;
  };
  (facts?.known?.people || []).forEach(add);
  (meeting?.invited || []).forEach((p) => add(personLabel(p)));
  (meeting?.attendees || []).forEach(add);
  const orgs = new Set(facts?.known?.orgs || []);
  dir.forEach((d) => d.organisation && orgs.add(d.organisation));
  // words that really occur in the transcript: a name said aloud (a vendor contact, say) is supported by it
  const heard = new Set(normTokens(transcript));
  return { names, orgs: [...orgs].filter(Boolean), heard };
}

const GENERIC_RESP = /^(chairperson|the chairperson|all|all attendees|all participants|not applicable|n\/a)$/i;

// Keeps only the parts of a Responsibility value that code can vouch for. An unknown name is dropped; if nothing
// is left the cell becomes [RESPONSIBILITY] for the note-taker to fill in. A bare first name that fits exactly one
// known person becomes that person's full name.
export function cleanResponsibility(value, known) {
  const parts = String(value || '')
    .replace(/\*\*/g, '')
    .split(/\s*(?:,|;|&|\/|\band\b|\+)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = [];
  for (const part of parts) {
    if (/^\[[^\]]+\]$/.test(part)) kept.push(part);
    else if (GENERIC_RESP.test(part)) kept.push(part);
    else {
      const org = known.orgs.find((o) => normName(o) === normName(part) || normName(o).startsWith(normName(part)) && normName(part).length >= 4);
      if (org) {
        kept.push(org);
        continue;
      }
      const hits = known.names.map((n) => ({ n, s: nameMatch(n, part) })).filter((x) => x.s > 0);
      const best = hits.length ? Math.max(...hits.map((h) => h.s)) : 0;
      const top = hits.filter((h) => h.s === best);
      const distinct = new Set(top.map((h) => normName(h.n)));
      if (distinct.size === 1) kept.push(top[0].n);
      else if (!top.length && known.heard) {
        // not a participant, but spoken in the meeting: keep it as the model wrote it
        const t = normTokens(part);
        if (t.length && t.every((w) => w.length >= 3 && known.heard.has(w))) kept.push(part);
      }
    }
  }
  const uniq = [...new Set(kept)];
  return uniq.length ? uniq.join(', ') : PH.resp;
}

// ---- parsing the model's answer ---------------------------------------------------------------------

const stripMd = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
const isDash = (s) => /^[-–—]*$/.test(String(s || '').trim());

// "| a | b \| c |" -> ['a', 'b | c']
export function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

// Data rows of the first markdown table in `lines` (header and separator removed).
export function tableRows(lines) {
  const rows = lines.filter((l) => l.trim().startsWith('|'));
  const sep = rows.findIndex(isSep);
  const body = sep >= 0 ? rows.slice(sep + 1) : rows.slice(1);
  return body.filter((l) => !isSep(l)).map(splitRow);
}

const SECTION_KEYS = [
  [/^meeting details\b|^details\b/i, 'details'],
  [/^attendees?\b/i, 'attendees'],
  [/^agenda\b/i, 'agenda'],
  [/^discussion\b/i, 'discussion'],
  [/^action/i, 'actions'],
  [/^next\s+meeting\b/i, 'next'],
  [/^(added by the completeness check|notes for the note-taker|for review)/i, 'review'],
];

// Splits markdown at its "## heading" lines: [{ key, title, lines }].
function splitSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const title = stripMd(m[2]);
      const hit = SECTION_KEYS.find(([re]) => re.test(title));
      if (hit) {
        cur = { key: hit[1], title, lines: [] };
        out.push(cur);
        continue;
      }
      if (m[1].length <= 2) cur = null; // a title or some other top-level heading ends the section
      continue; // sub-headings (###) are layout the model added: not content
    }
    if (cur) cur.lines.push(line);
  }
  return out;
}

const splitBr = (s) => String(s || '').split(/<br\s*\/?>|\s*¶\s*|\n/i).map((x) => stripMd(x.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))).filter((x) => x && !isDash(x));
const numericLead = (cells) => (cells.length > 1 && /^\d{1,3}\.?$/.test(cells[0]) ? cells.slice(1) : cells);

function parseAgenda(lines) {
  return lines
    .map((l) => stripMd(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')))
    .filter((l) => l && !isDash(l) && !/^none\b/i.test(l));
}

function parseDiscussion(lines) {
  const out = [];
  for (const raw of tableRows(lines)) {
    const c = numericLead(raw);
    if (c.length < 2) continue;
    const topic = stripMd(c[0]);
    const resp = c.length >= 3 ? stripMd(c[c.length - 1]) : '';
    const points = splitBr(c.length >= 3 ? c.slice(1, -1).join(' | ') : c[1]);
    if (!topic && !points.length) continue;
    out.push({ topic: topic || '—', points, resp });
  }
  return out;
}

function parseActions(lines) {
  const out = [];
  if (!lines.some((l) => l.trim().startsWith('|'))) {
    // a plain bullet list is accepted too, with no responsibility
    for (const t of parseAgenda(lines)) if (!/^none recorded/i.test(t)) out.push({ text: t, resp: '' });
    return out;
  }
  for (const raw of tableRows(lines)) {
    const c = numericLead(raw);
    if (!c.length || c.some((x) => /^none recorded\.?$/i.test(stripMd(x)))) continue;
    let resp = '';
    let due = '';
    if (c.length === 2) resp = stripMd(c[1]);
    else if (c.length >= 3) {
      resp = stripMd(c[1]);
      due = stripMd(c[2]); // a standard-format row (Action | Owner | Due): the due date goes to the end of the sentence
    }
    for (const t of splitBr(c[0])) {
      let text = t;
      if (due && !isDash(due) && !text.includes(due)) text = `${text.replace(/[.\s]+$/, '')}, by ${due}.`;
      out.push({ text, resp });
    }
  }
  return out;
}

function parseNext(lines) {
  const next = { when: '', where: '' };
  const pairs = [];
  for (const l of lines) {
    if (l.trim().startsWith('|')) {
      if (isSep(l)) continue;
      const c = splitRow(l);
      if (c.length >= 2) pairs.push([stripMd(c[0]), stripMd(c[1])]);
      continue;
    }
    const m = stripMd(l).replace(/^[-*•]\s*/, '').match(/^([A-Za-z ]{3,24}):\s*(.+)$/);
    if (m) pairs.push([m[1], m[2]]);
  }
  for (const [k, v] of pairs) {
    if (isDash(v)) continue;
    if (/^(date|time|when)/i.test(k) && !next.when) next.when = v;
    else if (/^(location|venue|place|where|mode)/i.test(k) && !next.where) next.where = v;
  }
  return next;
}

// The model's reply -> { agenda, discussion, actions, next }, or null when it does not fit the format (the
// caller then writes standard minutes instead). A reply is accepted when it has a Discussion table with at
// least one row: everything else may legitimately be empty.
export function parseModelOutput(text) {
  const secs = splitSections(text);
  const get = (k) => secs.find((s) => s.key === k);
  const disc = get('discussion');
  if (!disc) return null;
  const discussion = parseDiscussion(disc.lines);
  if (!discussion.length) return null;
  return {
    agenda: get('agenda') ? parseAgenda(get('agenda').lines) : [],
    discussion,
    actions: get('actions') ? parseActions(get('actions').lines) : [],
    next: get('next') ? parseNext(get('next').lines) : { when: '', where: '' },
  };
}

// Responsibility cells made safe, empty ones filled with the placeholder, next meeting defaulted.
export function guardProse(prose, known) {
  const fix = (r) => cleanResponsibility(r, known);
  return {
    agenda: prose.agenda,
    discussion: prose.discussion.map((d) => ({ ...d, resp: fix(d.resp) })),
    actions: prose.actions.map((a) => ({ ...a, resp: fix(a.resp) })),
    next: { when: prose.next?.when || TBD, where: prose.next?.where || TBD },
  };
}

// ---- the stored markdown ------------------------------------------------------------------------------

const cellMd = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const row = (cells) => `| ${cells.map(cellMd).join(' | ')} |`;
const groupHeading = (g) => (g.kind === 'client' ? `Attendees – Client Side (${g.org || PH.client})` : g.kind === 'si' ? `Attendees – System Integrator (${g.org})` : 'Attendees');
const groupCols = (g) => ['SR', 'Name', g.kind === 'client' ? 'Department' : 'Organisation', 'Designation'];

// facts + guarded prose (+ review notes) -> the markdown that is saved as the minutes.
export function composeMarkdown({ facts, prose, review = [] }) {
  const h = facts.header;
  const L = [MARKER, `# ${facts.title}`, '', '## Meeting details', '| Field | Value |', '|---|---|'];
  for (const [k, v] of [['Topic', h.topic], ['Mode', h.mode], ['Location', h.location], ['Date', h.date], ['Time', h.time], ['Chairperson', h.chair]]) L.push(row([k, v]));
  for (const g of facts.groups) {
    L.push('', `## ${groupHeading(g)}`, row(groupCols(g)), `|${groupCols(g).map(() => '---').join('|')}|`);
    const rows = g.rows.length ? g.rows : [{ name: '—', a: '—', desig: '—' }];
    rows.forEach((r, i) => L.push(row([i + 1, r.name, r.a, r.desig])));
  }
  L.push('', '## Agenda');
  (prose.agenda.length ? prose.agenda : ['—']).forEach((a) => L.push(`- ${a}`));
  L.push('', '## Discussion', row(['SR', 'Topic', 'Discussion / Decision Points', 'Responsibility']), '|---|---|---|---|');
  prose.discussion.forEach((d, i) => L.push(row([i + 1, d.topic, d.points.join('<br>'), d.resp])));
  L.push('', '## Action Items', row(['SR', 'Action Item', 'Responsibility']), '|---|---|---|');
  if (prose.actions.length) prose.actions.forEach((a, i) => L.push(row([i + 1, a.text, a.resp])));
  else L.push(row(['—', 'None recorded.', '—']));
  L.push('', '## Next Meeting', `Date and Time: ${prose.next.when}`, `Location: ${prose.next.where}`);
  const notes = [...(facts.notes || []).map((n) => `- ${n}`), ...review];
  if (notes.length) L.push('', '## Notes for the note-taker', '_Not part of the official minutes: hidden when printing or sending._', '', ...notes);
  return L.join('\n');
}

export const isAmnexMd = (md) => String(md || '').trimStart().startsWith(MARKER);

// The stored markdown -> the document model that is rendered, or null (not Amnex format, or unreadable).
export function parseAmnexMarkdown(md) {
  if (!isAmnexMd(md)) return null;
  const secs = splitSections(md);
  const title = (String(md).match(/^#\s+(.+)$/m) || [])[1]?.trim() || 'Meeting';
  const details = {};
  for (const r of tableRows(secs.find((s) => s.key === 'details')?.lines || [])) if (r.length >= 2) details[r[0].toLowerCase()] = r[1];
  const header = { topic: details.topic || title, mode: details.mode || '', location: details.location || '—', date: details.date || '', time: details.time || '', chair: details.chairperson || PH.chair };
  const groups = secs
    .filter((s) => s.key === 'attendees')
    .map((s) => ({
      kind: /client/i.test(s.title) ? 'client' : /integrator/i.test(s.title) ? 'si' : 'all',
      org: (s.title.match(/\(([^)]*)\)\s*$/) || [])[1] || '',
      rows: tableRows(s.lines)
        .map(numericLead)
        .filter((c) => c.length >= 3 && !(c[0] === '—' && c[1] === '—'))
        .map((c) => ({ name: c[0], a: c[1], desig: c[2] })),
    }));
  const get = (k) => secs.find((s) => s.key === k);
  const review = secs.filter((s) => s.key === 'review').map((s) => s.lines.join('\n').trim()).filter(Boolean);
  const next = get('next') ? parseNext(get('next').lines) : { when: '', where: '' };
  return {
    title,
    header,
    groups,
    agenda: get('agenda') ? parseAgenda(get('agenda').lines) : [],
    discussion: get('discussion') ? parseDiscussion(get('discussion').lines) : [],
    actions: get('actions') ? parseActions(get('actions').lines) : [],
    next: { when: next.when || TBD, where: next.where || TBD },
    review,
  };
}

// ---- rendering ----------------------------------------------------------------------------------------
// Borders, fills and padding are set on every cell: Word and the Apps Script PDF converter ignore stylesheet rules.

const FONT = 'font-family:Calibri,Carlito,\'Segoe UI\',\'Nirmala UI\',Arial,sans-serif';
const CELL = 'border:1px solid #000000;padding:5px 8px;vertical-align:top;text-align:left;font-size:10pt;line-height:1.35;color:#000000';
const navyCell = () => `border:1px solid ${ORG.accent};background:${ORG.accent};color:#ffffff;font-weight:bold;padding:5px 8px;font-size:10pt;line-height:1.35`;
const ZEBRA = '#f2f2f2';

const e = (s) => escapeHtml(s ?? '');
const navy = (inner, { w, center = true, colspan, mid = false } = {}) =>
  `<th${colspan ? ` colspan="${colspan}"` : ''}${w ? ` width="${w}"` : ''} bgcolor="${ORG.accent}" style="${navyCell()};text-align:${center ? 'center' : 'left'};${mid ? 'vertical-align:middle;' : 'vertical-align:top;'}${w ? `width:${w}px;` : ''}"><b><span style="color:#ffffff">${inner}</span></b></th>`;
const plain = (inner, { w, center = false, z = false, bold = false, colspan } = {}) =>
  `<td${colspan ? ` colspan="${colspan}"` : ''}${w ? ` width="${w}"` : ''}${z ? ` bgcolor="${ZEBRA}"` : ''} style="${CELL};${z ? `background:${ZEBRA};` : ''}${center ? 'text-align:center;' : ''}${w ? `width:${w}px;` : ''}">${bold ? `<b>${inner}</b>` : inner}</td>`;
const tr = (cells) => `<tr style="page-break-inside:avoid">${cells}</tr>`;
const table = (inner) => `<table class="amx-t" width="100%" cellspacing="0" cellpadding="0" border="1" style="border-collapse:collapse;width:100%;margin:0;${FONT}">${inner}</table>`;const gap = '<p class="amx-gap" style="margin:0;font-size:8pt;line-height:10pt">&nbsp;</p>';
const ul = (items, pad = 18) => `<ul style="margin:0;padding:0 0 0 ${pad}px">${items.map((i) => `<li style="margin:0 0 2px">${e(i)}</li>`).join('')}</ul>`;

// The document's tables (no page furniture): the same markup feeds screen, print, Word and the PDF.
export function renderDocBody(doc) {
  const h = doc.header;
  const out = [];
  out.push(`<h1 class="amx-h1" style="margin:0 0 14pt;font-size:32pt;line-height:1.1;font-weight:bold;color:${titleColor()};${FONT}">Meeting<br>Minutes</h1>`);
  out.push(table(tr(`${navy('Topic', { w: 117, mid: true })}${plain(e(h.topic), { bold: true })}`)), gap);
  out.push(table(tr(`${navy('Mode', { w: 117, mid: true })}${plain(e(h.mode), { bold: true })}`) + tr(`${navy('Location', { w: 117, mid: true })}${plain(e(h.location), { bold: true })}`)), gap);
  out.push(
    table(
      `<thead>${tr(`${navy('Date', { w: 117 })}${navy('Time', { w: 128 })}${navy('Chairperson')}`)}</thead><tbody>${tr(`${plain(e(h.date), { center: true, bold: true })}${plain(e(h.time), { center: true, bold: true })}${plain(e(h.chair), { center: true, bold: true })}`)}</tbody>`
    ),
    gap
  );
  for (const g of doc.groups) {
    const title = g.kind === 'client' ? `Attendees — ${e(g.org || PH.client)} / Client Side` : g.kind === 'si' ? `Attendees — System Integrator (${e(g.org)})` : 'Attendees';
    const cols = groupCols(g);
    const rows = g.rows.length ? g.rows : [{ name: '—', a: '—', desig: '—' }];
    out.push(
      table(
        `<thead>${tr(navy(title, { colspan: 4, center: false }))}${tr(navy(cols[0] === 'SR' ? 'SR No.' : cols[0], { w: 56 }) + navy(cols[1]) + navy(cols[2]) + navy(cols[3]))}</thead><tbody>${rows
          .map((r, i) => tr(plain(String(i + 1), { w: 56, center: true, bold: true, z: i % 2 === 1 }) + plain(e(r.name), { bold: true, z: i % 2 === 1 }) + plain(e(r.a), { z: i % 2 === 1 }) + plain(e(r.desig), { z: i % 2 === 1 })))
          .join('')}</tbody>`
      ),
      gap
    );
  }
  out.push(table(`<thead>${tr(navy('Agenda', { center: false }))}</thead><tbody>${tr(plain(doc.agenda.length ? ul(doc.agenda, 24) : '—'))}</tbody>`), gap);
  out.push(
    table(
      `<thead>${tr(navy('SR No.', { w: 56 }) + navy('Topic', { w: 150 }) + navy('Discussion / Decision Points') + navy('Responsibility', { w: 130 }))}</thead><tbody>${
        doc.discussion.length
          ? doc.discussion
              .map((d, i) => {
                const z = i % 2 === 1;
                const pts = d.points.length ? d.points.map((p, k) => `<p style="margin:0 0 ${k === d.points.length - 1 ? 0 : 5}pt">${e(p)}</p>`).join('') : '—';
                return tr(plain(String(i + 1), { w: 56, center: true, bold: true, z }) + plain(e(d.topic), { w: 150, bold: true, z }) + plain(pts, { z }) + plain(e(d.resp), { w: 130, bold: true, z }));
              })
              .join('')
          : tr(plain('—', { colspan: 4 }))
      }</tbody>`
    ),
    gap
  );
  out.push(
    table(
      `<thead>${tr(navy('Sr.', { w: 56 }) + navy('Action Item') + navy('Responsibility', { w: 130 }))}</thead><tbody>${
        doc.actions.length
          ? doc.actions.map((a, i) => tr(plain(String(i + 1), { w: 56, center: true, bold: true, z: i % 2 === 1 }) + plain(ul([a.text]), { z: i % 2 === 1 }) + plain(e(a.resp), { w: 130, bold: true, z: i % 2 === 1 }))).join('')
          : tr(plain('None recorded.', { colspan: 3 }))
      }</tbody>`
    ),
    gap
  );
  out.push(
    table(`<thead>${tr(navy('Next Meeting', { colspan: 2, center: false }))}</thead><tbody>${tr(navy('Date and Time', { w: 150, mid: true }) + plain(e(doc.next.when), { bold: true }))}${tr(navy('Location', { w: 150, mid: true }) + plain(e(doc.next.where), { bold: true }))}</tbody>`)
  );
  return out.join('');
}

// Page furniture for the browser: the running header is a thead (repeats on every printed page in any engine);
// "Page X of Y" and the Confidential line are @page margin boxes in PRINT_CSS (Chrome 131+). The tfoot only closes
// the document on screen.
export const runningTitle = (doc) => `${doc.title} – Minutes of Meeting`;

// The on-screen / print fragment (also what is wrapped into a standalone document).
export function renderPrintFragment(doc) {
  const review = (doc.review || []).length
    ? `<div class="amx-review no-print" style="margin:18px 0 0;padding:10px 14px;border:1px dashed #b45309;background:#fffbeb;color:#1f2328;border-radius:8px;font:13px/1.5 system-ui,sans-serif">${doc.review.map((r) => renderMd(r)).join('')}</div>`
    : '';
  return `<div class="amx" style="max-width:794px;margin:0 auto;padding:12px 24px;background:#ffffff;color:#000000;${FONT}"><table class="amx-wrap" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><thead><tr><td class="amx-rh" style="border:0;border-bottom:1px solid ${ORG.accent};padding:0 0 3px;text-align:center;font-size:8.5pt;color:#595959;border-bottom:1px solid ${ORG.accent}">${e(runningTitle(doc))}</td></tr></thead><tfoot><tr><td class="amx-ft" style="border:0;border-top:1px solid ${ORG.accent};padding:4px 0 0;text-align:center;font-size:8.5pt;color:#000000;border-top:1px solid ${ORG.accent}">${e(ORG.confidential)}</td></tr></tfoot><tbody><tr><td style="border:0;padding:14px 0 0">${renderDocBody(doc)}</td></tr></tbody></table>${review}</div>`;
}

// The browser's print rules. extension/print.css must stay byte-identical (a test checks it).
export const printCss = (confidential = 'Confidential') => `/* Debrief: official minutes, A4. Linked from mom.html with media="print"; also inlined in standalone documents. */
@page amx {
  size: A4;
  margin: 22.5mm 12.7mm 25mm 19mm; /* the template: 2.25 cm top, 1.27 cm right, 2.5 cm bottom, 1.9 cm left */
  @bottom-left { content: ""; width: 42mm; border-top: 0.5pt solid ${ORG.accent}; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); width: 42mm; font: 700 12pt Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #000; text-align: right; vertical-align: top; padding-top: 1mm; white-space: nowrap; border-top: 0.5pt solid ${ORG.accent}; }
  @bottom-center { content: "${String(confidential).replace(/["\\\n]/g, " ")}"; font: 9pt Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #000; text-align: center; vertical-align: top; padding-top: 2mm; border-top: 0.5pt solid ${ORG.accent}; }
}
.amx { page: amx; }
.amx, .amx * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.amx table { page-break-inside: auto; }
.amx tr { break-inside: avoid; page-break-inside: avoid; }
.amx thead { display: table-header-group; }
.amx-gap { break-inside: avoid; }
.amx-h1 { break-after: avoid; }
@media print {
  .amx tfoot { display: none; } /* on paper the Confidential line is the page footer above; on screen it closes the document */
  .no-print, .amx-review { display: none !important; }
  body:has(.amx) { background: #fff !important; }
  body:has(.amx) main { max-width: none !important; margin: 0 !important; padding: 0 !important; }
  body:has(.amx) main > header { display: none !important; }
  .amx { max-width: none !important; padding: 0 !important; margin: 0 !important; }
}
`;
export const PRINT_CSS = printCss('Confidential'); // extension/print.css is exactly this; the page adds the organisation's footer line on top

// A complete, self-contained A4 page (inline styles only; no outside resources).
export function renderStandaloneHtml(doc) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(doc.title)} – Minutes of Meeting</title><style>body{margin:0;background:#fff}\n${printCss(ORG.confidential)}</style></head><body>${renderPrintFragment(doc)}</body></html>`;
}

// Word: the same tables, plus a real Word header and footer (Page X of Y fields). Word ignores @page margin boxes
// and the thead/tfoot trick, so the page furniture uses Word's own header/footer markup.
export function renderWordHtml(doc) {
  const headerDiv = `<div style="mso-element:header" id="h1"><p style="margin:0;text-align:center;font-size:8.5pt;color:#595959;border-bottom:1px solid ${ORG.accent}">${e(runningTitle(doc))}</p></div>`;
  const footerDiv = `<div style="mso-element:footer" id="f1"><p style="margin:0;text-align:right;font-size:12pt;font-weight:bold">Page <span style="mso-field-code:' PAGE '"><span style="mso-no-proof:yes">1</span></span> of <span style="mso-field-code:' NUMPAGES '"><span style="mso-no-proof:yes">1</span></span></p><p style="margin:0;text-align:center;font-size:9pt;border-top:1px solid ${ORG.accent}">${e(ORG.confidential)}</p></div>`;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${e(doc.title)}</title><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]--><style>@page Section1{size:210mm 297mm;margin:22.5mm 12.7mm 25mm 19mm;mso-header-margin:13mm;mso-footer-margin:12mm;mso-header:h1;mso-footer:f1}div.Section1{page:Section1}body{font-family:Calibri,sans-serif;font-size:10pt}table{border-collapse:collapse}p{margin:0}</style></head><body><div class="Section1">${renderDocBody(doc)}<table id="hrdftrtbl" border="0" cellspacing="0" cellpadding="0"><tr><td>${headerDiv}</td><td>${footerDiv}</td></tr></table></div></body></html>`;
}

// What the relay turns into the PDF attachment. Apps Script's converter ignores @page margin boxes and may ignore
// repeating rows, so there is no page-number furniture here; the title and the Confidential line frame the document once.
export function renderPdfHtml(doc) {
  return `<html><head><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{${FONT};font-size:10pt;color:#000}</style></head><body><p style="margin:0 0 8pt;text-align:center;font-size:8.5pt;color:#595959;border-bottom:1px solid ${ORG.accent}">${e(runningTitle(doc))}</p>${renderDocBody(doc)}<p style="margin:14pt 0 0;text-align:center;font-size:8.5pt;border-top:1px solid ${ORG.accent}">${e(ORG.confidential)}</p></body></html>`;
}

// ---- email cover ----------------------------------------------------------------------------------------

// A short 600 px cover: topic, when, who chaired, and the action items. The full minutes are attached.
export function renderEmailCover(doc, { attached = [] } = {}) {
  const th = (t, w) => `<th align="left" bgcolor="${ORG.accent}" style="border:1px solid ${ORG.accent};background:${ORG.accent};color:#ffffff;padding:6px 9px;font-size:13px;text-align:left${w ? `;width:${w}px` : ''}"${w ? ` width="${w}"` : ''}>${t}</th>`;
  const td = (t, extra = '') => `<td valign="top" style="border:1px solid #000000;padding:6px 9px;font-size:13px;vertical-align:top;${extra}">${t}</td>`;
  const when = [doc.header.date, doc.header.time].filter(Boolean).join(', ');
  const actions = doc.actions.length
    ? `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 0"><tr>${th('Sr.', 36)}${th('Action Item')}${th('Responsibility', 140)}</tr>${doc.actions
        .map((a, i) => `<tr>${td(String(i + 1), 'text-align:center;font-weight:bold')}${td(e(a.text))}${td(e(a.resp), 'font-weight:bold')}</tr>`)
        .join('')}</table>`
    : '<p style="margin:6px 0 0;font-size:13px">No action items were recorded.</p>';
  const att = attached.length ? `<p style="margin:14px 0 0;font-size:12px;color:#3b4048">The full minutes in the official format are attached (${e(attached.join(' and '))}).</p>` : '';
  return `<div style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.45;color:#000000;max-width:600px;width:100%">
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr><td bgcolor="${ORG.accent}" style="border:1px solid ${ORG.accent};background:${ORG.accent};color:#ffffff;padding:10px 14px;font-size:12px;letter-spacing:.04em">MINUTES OF MEETING</td></tr></table>
<p style="margin:12px 0 2px;font-size:18px;font-weight:bold;color:#0c2d6b">${e(doc.header.topic)}</p>
<p style="margin:0;font-size:13px;color:#3b4048">${e(when)}${doc.header.mode ? ` · ${e(doc.header.mode)}` : ''}</p>
${doc.header.chair && doc.header.chair !== PH.chair ? `<p style="margin:2px 0 0;font-size:13px;color:#3b4048">Chairperson: ${e(doc.header.chair)}</p>` : ''}
<p style="margin:14px 0 0;font-size:14px;font-weight:bold">Action items</p>
${actions}
${att}
<p style="margin:16px 0 0;padding-top:8px;border-top:1px solid ${ORG.accent};font-size:11px;color:#595959;text-align:center">${e(ORG.confidential)}</p>
</div>`;
}

// Plain-text version of the cover for the mail's text part.
export function emailCoverText(doc) {
  const L = [doc.header.topic, [doc.header.date, doc.header.time, doc.header.mode].filter(Boolean).join(' · '), '', 'Action items:'];
  if (doc.actions.length) doc.actions.forEach((a, i) => L.push(`${i + 1}. ${a.text} (${a.resp})`));
  else L.push('None recorded.');
  L.push('', ORG.confidential);
  return L.join('\n');
}

// ---- entry points for the minutes page -----------------------------------------------------------------

// Minutes markdown -> HTML for the page: the official layout for Amnex-format minutes, else the given renderer.
export function renderMinutesHtml(md, fallback = renderMd) {
  const doc = parseAmnexMarkdown(md);
  return doc ? renderPrintFragment(doc) : fallback(md);
}

// The full standalone A4 HTML document for Amnex-format minutes, or null for any other minutes.
export function standaloneA4Html(md) {
  const doc = parseAmnexMarkdown(md);
  return doc ? renderStandaloneHtml(doc) : null;
}
