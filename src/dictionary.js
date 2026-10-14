// Personal dictionary and attendee-aware name correction.
//
// Settings text, one entry per line:
//   Amal | Aman, Amaal        the right spelling | words it is often misheard as
//   Unified Registry          a plain term: only used as a spelling hint
// Lines starting with # are comments.

// Marks (Devanagari matras, Malayalam vowel signs) belong to the word, or a name ends up replaced inside a longer word.
const WORD = '\\p{L}\\p{M}\\p{N}_';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').trim();

export function parseDictionary(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, rest = ''] = line.split('|');
    const canonical = name.trim();
    if (!canonical) continue;
    const aliases = rest.split(',').map((a) => a.trim()).filter((a) => a && norm(a) !== norm(canonical));
    entries.push({ name: canonical, aliases });
  }
  return entries;
}

export function serializeDictionary(entries) {
  return entries.map((e) => (e.aliases.length ? `${e.name} | ${e.aliases.join(', ')}` : e.name)).join('\n');
}

// Adds "wrong" as an alias of "right", creating the line if needed. The rest of the text, comments
// included, is left exactly as the user wrote it.
const oneLine = (x) => String(x || '').replace(/[\r\n,|]+/g, ' ').replace(/\s+/g, ' ').trim();
export function learnAlias(text, right, wrong) {
  const r = oneLine(right);
  const w = oneLine(wrong);
  if (!r) return String(text || '');
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith('#') && norm(t.split('|')[0]) === norm(r);
  });
  if (at < 0) {
    const add = w && norm(w) !== norm(r) ? `${r} | ${w}` : r;
    return [...lines.filter((l, i) => !(i === lines.length - 1 && !l.trim())), add].join('\n');
  }
  const [name, rest = ''] = lines[at].split('|');
  const aliases = rest.split(',').map((a) => a.trim()).filter(Boolean);
  if (w && norm(w) !== norm(r) && !aliases.some((a) => norm(a) === norm(w))) aliases.push(w);
  lines[at] = aliases.length ? `${name.trim()} | ${aliases.join(', ')}` : name.trim();
  return lines.join('\n');
}

// Names of attendees and their first names, for the "is this alias a real person here?" test.
function attendeeKeys(attendees) {
  const keys = new Set();
  for (const a of attendees || []) {
    const full = norm(a);
    if (!full) continue;
    keys.add(full);
    keys.add(full.split(/\s+/)[0]);
  }
  return keys;
}

// Replaces misheard aliases by the right spelling, in a single pass so one correction can never be
// corrected again by another entry. An alias that is itself somebody in this meeting is left alone:
// if Aman is on the attendee list, "Aman" really is Aman.
const compiled = new WeakMap();
function compile(entries) {
  let c = compiled.get(entries);
  if (c) return c;
  const map = new Map();
  for (const e of entries) for (const a of e.aliases) if (!map.has(norm(a))) map.set(norm(a), e.name);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  // Aliases keep their own case in the text, so match case-insensitively on the original spellings.
  const source = entries.flatMap((e) => e.aliases).sort((a, b) => b.length - a.length).map(esc);
  c = { map, re: source.length ? new RegExp(`(?<![${WORD}])(?:${source.join('|')})(?![${WORD}])`, 'giu') : null, keys };
  compiled.set(entries, c);
  return c;
}

export function applyDictionary(text, entries, attendees = []) {
  if (!text || !entries?.length) return text;
  const { map, re } = compile(entries);
  if (!re) return text;
  const present = attendeeKeys(attendees);
  return text.replace(re, (m) => {
    const k = norm(m);
    return present.has(k) || !map.has(k) ? m : map.get(k);
  });
}

// Terms to give the speech and minutes models as spelling hints.
export function hintTerms(entries, attendees = []) {
  const seen = new Set();
  const out = [];
  for (const t of [...(attendees || []), ...entries.map((e) => e.name)]) {
    const k = norm(t);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(t.trim());
    }
  }
  return out;
}

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

const COMMON = new Set('this that then than them they there their these those when what where which while with from have has had will would could should about after again also been being both come did does done each even every just know like made make many more most much must only other over said same some such take them than very well were your into out how its our own put she her him his who why yes yet'.split(' '));

// Capitalised words in the text that look like a mis-heard attendee first name (one letter off).
// Suggestions only: the user decides, because "Amen" may really be "Amen".
export function suggestNames(text, attendees, entries = []) {
  const first = [...new Set((attendees || []).map((a) => norm(a).split(/\s+/)[0]).filter((f) => f.length >= 3))];
  if (!first.length) return [];
  const known = new Set([...first, ...entries.flatMap((e) => [norm(e.name), ...e.aliases.map(norm)])]);
  const counts = new Map();
  for (const m of String(text || '').matchAll(/(?<![\p{L}\p{M}\p{N}_])\p{Lu}[\p{L}\p{M}]{2,}(?![\p{L}\p{M}\p{N}_])/gu)) {
    const w = m[0];
    const k = norm(w);
    if (known.has(k) || COMMON.has(k)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const out = [];
  for (const [w, count] of counts) {
    const k = norm(w);
    const close = first.filter((f) => Math.abs(f.length - k.length) <= 1 && distance(k, f) === 1);
    if (close.length === 1) out.push({ found: w, suggest: attendees.find((a) => norm(a).split(/\s+/)[0] === close[0]).split(/\s+/)[0], count });
  }
  return out.sort((a, b) => b.count - a.count);
}

// Plain-text prompt line for STT models and the minutes writer.
export function glossaryLine(entries, attendees) {
  const terms = hintTerms(entries, attendees);
  return terms.length ? terms.join(', ') : '';
}

// Whole-word, case-insensitive replace used by the "Fix a name" tool.
export function replaceWord(text, wrong, right) {
  if (!wrong) return text;
  return String(text).replace(new RegExp(`(?<![${WORD}])${esc(wrong)}(?![${WORD}])`, 'giu'), () => right);
}

// ---- learning from meetings -------------------------------------------------------------------

const titleCase = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
function cleanLearned(n) {
  const c = String(n || '').replace(/\s+/g, ' ').trim();
  return c && c.length <= 40 && /^\p{L}[\p{L}\p{M} .'-]*$/u.test(c) && !/^(you|guest|unknown|presentation|presenting)$/i.test(c) ? c : '';
}

// Names this meeting shows are real (attendees, people seen in the call, the invite, caption speakers),
// plus transcript words that look like a one-letter mishearing of one of them, seen at least twice.
export function learnFromMeeting(meeting, { entries = [], myName = '' } = {}) {
  const names = new Set();
  const add = (n) => {
    const c = cleanLearned(n);
    if (c) names.add(c);
  };
  (meeting.attendees || []).forEach(add);
  Object.keys(meeting.presence || {}).forEach((n) => add(/^you$/i.test(n) ? myName : n));
  (meeting.invited || []).filter((p) => p.status !== 'no').forEach((p) => add(p.name || titleCase(String(p.email || '').split('@')[0].replace(/[._-]+/g, ' '))));
  (meeting.captions || []).forEach((c) => add(/^you$/i.test(c.name) ? myName : c.name));
  const list = [...names];
  const text = (meeting.segments || []).map((s) => s.text).join(' ');
  return { names: list, candidates: suggestNames(text, list, entries).filter((c) => c.count >= 2) };
}

// Merges one meeting's findings into the stored "learned" record. Returns the new record and any
// fixes that should be accepted automatically.
export function mergeLearned(learned, found, { auto = false, title = '', now = Date.now() } = {}) {
  const next = { names: { ...(learned?.names || {}) }, pending: [...(learned?.pending || [])], rejected: [...(learned?.rejected || [])] };
  for (const n of found.names) next.names[n] = now;
  const keys = Object.keys(next.names);
  if (keys.length > 300) for (const k of keys.sort((a, b) => next.names[a] - next.names[b]).slice(0, keys.length - 300)) delete next.names[k];
  for (const c of found.candidates) {
    const id = `${c.found.toLowerCase()}>${c.suggest.toLowerCase()}`;
    if (next.rejected.includes(id)) continue;
    const have = next.pending.find((p) => p.id === id);
    if (have) {
      have.count += c.count;
      have.at = now;
    } else next.pending.push({ id, found: c.found, suggest: c.suggest, count: c.count, meeting: title, at: now });
  }
  const accepted = auto ? next.pending.filter((p) => p.count >= 3) : [];
  next.pending = next.pending.filter((p) => !accepted.includes(p));
  return { learned: next, accepted };
}
