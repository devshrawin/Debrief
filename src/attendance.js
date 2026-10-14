import { cleanPresence } from './iconText.js';
// Who was invited vs who actually joined, and the attendance table for the minutes.
//
// invited: [{ name?, email?, status? }]       from the calendar event (status: yes / no / maybe / invited)
// presence: { "Display name": [firstSeenSec, lastSeenSec, samples] }   sampled from Meet while recording

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);

function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a.length < 4) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

// Names a person can go by: calendar name, email name part, and any dictionary aliases.
function identities(p, entries = []) {
  const ids = new Set();
  const add = (v) => {
    const t = tokens(v);
    if (t.length) ids.add(t.join(' '));
  };
  add(p.name);
  if (p.email) add(String(p.email).split('@')[0].replace(/[._-]+/g, ' '));
  for (const e of entries) {
    const names = [e.name, ...e.aliases].map((x) => tokens(x).join(' '));
    for (const id of [...ids]) if (names.includes(id)) names.forEach((n) => ids.add(n));
  }
  return [...ids];
}

// 1 = same name. Two different people must never be merged: a one-letter-off first name only counts
// when the surnames agree, and a different surname is a different person.
function score(a, b) {
  if (a === b) return 1;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const fa = ta[0];
  const fb = tb[0];
  const sameFirst = fa === fb;
  const closeFirst = !sameFirst && lev1(fa, fb);
  if (!sameFirst && !closeFirst) return 0;
  if (ta.length === 1 || tb.length === 1) return sameFirst ? 0.7 : 0; // first name only: handled with an ambiguity check
  // "Aman S." vs "Aman Sharma": every later word of one must be a prefix of a word of the other.
  const rest = (x, y) => x.slice(1).every((w) => y.slice(1).some((v) => v === w || v.startsWith(w) || w.startsWith(v)));
  const surnames = rest(ta, tb) || rest(tb, ta);
  if (!surnames) return 0;
  return sameFirst ? 0.9 : 0.6;
}

export function matchPeople(invited, presenceIn, { entries = [], myName = '' } = {}) {
  const presence = cleanPresence(presenceIn);
  // "You" is the person running Debrief: their name if known, else the organiser of the invite.
  const owner = (invited || []).find((p) => p.status === 'owner');
  const selfName = myName || owner?.name || owner?.email || '';
  const here = Object.entries(presence || {}).map(([name, v]) => ({ name: /^you$/i.test(name.trim()) && selfName ? selfName : name, first: v[0], last: v[1], samples: v[2] || 1 }));
  const rows = (invited || []).map((p) => ({ ...p, ids: identities(p, entries), match: null }));
  const pairs = [];
  rows.forEach((r, ri) => here.forEach((h, hi) => {
    const hid = identities({ name: h.name }, entries);
    let best = Math.max(0, ...r.ids.flatMap((a) => hid.map((b) => score(a, b))));
    // A bare first name is only evidence if no other invitee shares that first name.
    if (best > 0 && best < 0.9) {
      const first = hid[0]?.split(' ')[0];
      const sharing = rows.filter((x) => x.ids.some((id) => id.split(' ')[0] === first)).length;
      if (sharing > 1) best = 0;
    }
    if (best >= 0.55) pairs.push({ ri, hi, best });
  }));
  pairs.sort((a, b) => b.best - a.best);
  const usedR = new Set();
  const usedH = new Set();
  for (const p of pairs) {
    if (usedR.has(p.ri) || usedH.has(p.hi)) continue;
    usedR.add(p.ri);
    usedH.add(p.hi);
    rows[p.ri].match = here[p.hi];
  }
  return {
    rows: rows.map((r) => ({ name: r.name || r.email, email: r.email, status: r.status, present: r.match || null })),
    uninvited: here.filter((_, i) => !usedH.has(i)),
  };
}

const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const RSVP = { yes: 'Accepted', no: 'Declined', maybe: 'Maybe', invited: 'No reply', owner: 'Organiser' };

// Markdown section for the minutes, or '' if there is nothing to say.
export function attendanceMarkdown({ invited, presence: presenceIn, durationSec, entries, myName }) {
  const presence = cleanPresence(presenceIn);
  const hasInvited = (invited || []).length > 0;
  const hasPresence = Object.keys(presence || {}).length > 0;
  if (!hasInvited && !hasPresence) return '';
  const { rows, uninvited } = matchPeople(invited, presence, { entries, myName });
  const lateAfter = 180;
  const earlyBefore = 180;
  const when = (p) => {
    const notes = [];
    if (p.first > lateAfter && durationSec > 600) notes.push('joined late');
    if (durationSec && p.last < durationSec - earlyBefore && durationSec > 600) notes.push('left early');
    return notes.join(', ');
  };
  const lines = ['## Attendance'];
  if (hasInvited && hasPresence) {
    const came = rows.filter((r) => r.present).length;
    lines.push(`${came} of ${rows.length} invited people were seen in the meeting${uninvited.length ? `, plus ${uninvited.length} who were not on the invite` : ''}.`, '');
    lines.push('| Person | Invite | In the meeting | Joined | Left | Note |', '|---|---|---|---|---|---|');
    for (const r of rows) {
      const p = r.present;
      lines.push(`| ${r.name} | ${RSVP[r.status] || r.status || '—'} | ${p ? 'Yes' : '**Absent**'} | ${p ? mmss(p.first) : '—'} | ${p ? mmss(p.last) : '—'} | ${p ? when(p) : ''} |`);
    }
    for (const p of uninvited) lines.push(`| ${p.name} | Not invited | Yes | ${mmss(p.first)} | ${mmss(p.last)} | ${when(p)} |`);
    const absent = rows.filter((r) => !r.present).map((r) => r.name);
    if (absent.length) lines.push('', `Not seen in the meeting: ${absent.join(', ')}. Action items for them need to be passed on.`);
  } else if (hasPresence) {
    lines.push('People seen in the meeting (no calendar invite was available to compare):', '', '| Person | Joined | Left | Note |', '|---|---|---|---|');
    for (const [name, v] of Object.entries(presence)) lines.push(`| ${/^you$/i.test(name) && myName ? myName : name} | ${mmss(v[0])} | ${mmss(v[1])} | ${when({ first: v[0], last: v[1] })} |`);
  } else {
    lines.push('Invited:', '', ...rows.map((r) => `- ${r.name} (${RSVP[r.status] || r.status || 'invited'})`), '', '_Who actually attended could not be read from the meeting page._');
  }
  lines.push('', '_Attendance is read from the meeting page and may miss people whose video tile was not on screen._');
  return lines.join('\n');
}
