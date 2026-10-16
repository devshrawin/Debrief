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

// The calendar often gives only an e-mail address, while the call shows display names. Debrief remembers which address is
// which name (learned from every meeting where the match was clear, or set by hand) and uses it everywhere.
let KNOWN = {};
export const setEmailNames = (map) => {
  KNOWN = Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
};
export const knownName = (email) => KNOWN[String(email || '').toLowerCase()] || '';

// "akash8@amnex.com" -> "Akash", "amal.samad@x.com" -> "Amal Samad": a readable stand-in until the real name is known.
export function prettyFromEmail(email) {
  const local = String(email || '').split('@')[0];
  const words = local.split(/[._-]+/).map((w) => w.replace(/\d+$/, '')).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// What to call an invitee: the calendar's name, else the name learned for the address, else a readable guess.
export const personLabel = (p) => p.name || knownName(p.email) || prettyFromEmail(p.email) || p.email || '';

// Names a person can go by: calendar name, email name part, and any dictionary aliases.
function identities(p, entries = []) {
  const ids = new Set();
  const add = (v) => {
    const t = tokens(v);
    if (t.length) ids.add(t.join(' '));
  };
  add(p.name);
  if (p.email && knownName(p.email)) add(knownName(p.email));
  if (p.email) {
    // "akash8@amnex.com" is "akash", "amal.samad@x.com" is "amal samad", "amalsamad678@gmail.com" is "amalsamad":
    // the numbers people add to make an address unique are not part of the name.
    const local = String(p.email).split('@')[0];
    add(local.replace(/[._-]+/g, ' '));
    add(local.split(/[._-]+/).map((w) => w.replace(/\d+$/, '')).filter(Boolean).join(' '));
  }
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
  if ((ta.length === 1) !== (tb.length === 1)) {
    const [one, many] = ta.length === 1 ? [ta[0], tb] : [tb[0], ta];
    if (one.length >= 6 && one === many.join('')) return 0.9;
  }
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
  // Seen, but their first name fits two or more invitees who were not matched (akash8@ and akash9@ for "Akash Behera"):
  // not guessable, so both sides say so instead of listing a stranger and an absentee.
  const left = here.map((h, i) => ({ h, i })).filter((x) => !usedH.has(x.i));
  const couldBe = new Map();
  const mayBe = new Map();
  for (const { h, i } of left) {
    const first = identities({ name: h.name }, entries)[0]?.split(' ')[0];
    const cands = rows.map((r, ri) => ({ r, ri })).filter((x) => !usedR.has(x.ri) && x.r.ids.some((id) => id.split(' ')[0] === first && id.split(' ').length === 1));
    if (cands.length > 1) {
      couldBe.set(i, cands.map((x) => x.r.email || personLabel(x.r)));
      for (const c of cands) mayBe.set(c.ri, [...(mayBe.get(c.ri) || []), h.name]);
    }
  }
  return {
    rows: rows.map((r, ri) => ({ name: personLabel(r), email: r.email, status: r.status, present: r.match || null, mayBe: mayBe.get(ri) || null })),
    uninvited: here.filter((_, i) => !usedH.has(i)).map((h) => ({ ...h, couldBe: couldBe.get(here.indexOf(h)) || null })),
  };
}

// "Deep Patel (deep5@amnex.com)": the name when it is known, always with the address, so rows read the same way.
export const withAddress = (r) => (r.email && r.name && r.name.toLowerCase() !== String(r.email).toLowerCase() ? `${r.name} (${r.email})` : r.name || r.email || '');

// Address -> name for every invitee who was matched to somebody seen in the call. Only a real name is kept.
export function learnEmailNames(rows) {
  const out = {};
  for (const r of rows || []) {
    const seen = r.present?.name;
    if (r.email && seen && !/@/.test(seen) && !/^you$/i.test(seen) && seen.trim().split(/\s+/).length >= 1 && seen.toLowerCase() !== String(r.email).toLowerCase()) out[String(r.email).toLowerCase()] = seen.trim();
  }
  return out;
}

const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const RSVP = { yes: 'Accepted', no: 'Declined', maybe: 'Maybe', invited: 'No reply', owner: 'Organiser' };

// Markdown section for the minutes, or '' if there is nothing to say.
export function attendanceMarkdown({ invited, presence: presenceIn, durationSec, entries, myName, whyNoInvite = '' }) {
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
    lines.push(`${came} of ${rows.length} invited people were seen in the meeting${uninvited.length ? `, plus ${uninvited.length} who could not be matched to the invite` : ''}.`, '');
    lines.push('| Person | Invite | In the meeting | Joined | Left | Note |', '|---|---|---|---|---|---|');
    for (const r of rows) {
      const p = r.present;
      lines.push(`| ${withAddress(r)} | ${RSVP[r.status] || r.status || '—'} | ${p ? 'Yes' : '**Absent**'} | ${p ? mmss(p.first) : '—'} | ${p ? mmss(p.last) : '—'} | ${p ? when(p) : r.mayBe ? `may be ${r.mayBe.join(' or ')}` : ''} |`);
    }
    for (const p of uninvited) lines.push(`| ${p.name} | ${p.couldBe ? 'Not matched' : 'Not invited'} | Yes | ${mmss(p.first)} | ${mmss(p.last)} | ${[when(p), p.couldBe ? `could be ${p.couldBe.join(' or ')}` : ''].filter(Boolean).join(', ')} |`);
    const absent = rows.filter((r) => !r.present).map((r) => withAddress(r));
    if (absent.length) lines.push('', `Not seen in the meeting: ${absent.join(', ')}. Action items for them need to be passed on.`);
  } else if (hasPresence) {
    lines.push(`People seen in the meeting. Nobody can be listed as absent because ${whyNoInvite || 'no calendar invite was found to compare with'}.`, '', '| Person | Joined | Left | Note |', '|---|---|---|---|');
    for (const [name, v] of Object.entries(presence)) lines.push(`| ${/^you$/i.test(name) && myName ? myName : name} | ${mmss(v[0])} | ${mmss(v[1])} | ${when({ first: v[0], last: v[1] })} |`);
  } else {
    lines.push('Invited:', '', ...rows.map((r) => `- ${withAddress(r)} (${RSVP[r.status] || r.status || 'invited'})`), '', '_Who actually attended could not be read from the meeting page._');
  }
  lines.push('', hasInvited && hasPresence ? '_"Absent" means not seen: attendance is read from the call page (video tiles), and from speech and captions when those are on, so someone who joined without being on screen may be listed as absent. Check before acting._' : '_Who was in the call is read from the call page and may miss people whose video tile was not on screen._');
  return lines.join('\n');
}
