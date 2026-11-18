// Structured minutes: the model returns ONE JSON document, code validates it, guards it and renders the Markdown.
// Pure functions (no DOM, no chrome.*), unit-tested with fake model replies.
//
// The shape (stored as meeting.items):
//   {
//     title?:     string,
//     overview:   string,                                   two or three sentences
//     summary:    string[],                                 3-6 bullets
//     topics:     [{ title, status, points: string[] }],    one per workstream, status in a few words
//     decisions:  [{ text, at }],
//     actions:    [{ text, owner, due, at, quote, id?, status?, doneAt? }],
//     risks:      [{ text, at }],
//     questions:  [{ text, at }],
//     next:       [{ text, at? }],
//   }
// `at` is "mm:ss" (or "h:mm:ss") copied from the transcript line, '' when unknown. owner is a person, "Team" or
// "Not stated"; due is the date said or "Not stated". id/status/doneAt are added by assignIds (status 'open' | 'done').
// The model may also return `previous: [{ id, status, note }]` about carried action items (see src/actions.js).
import { TRANSCRIPT_NOTES, INJECTION_GUARD, NAMES_RULES, COMPLETENESS_RULES, OWNER_DUE_RULES, buildUserPrompt, wordsOf } from './prompt.js';
import { nameMatch, splitRow, TBD, PH } from './orgtemplate.js';
import { carryText, reviewSection } from './actions.js';
import { foldToken } from './ask.js';

const LISTS = ['decisions', 'actions', 'risks', 'questions', 'next'];
const MAX_TEXT = 600;
const MAX_LIST = 200;
const NOT_STATED = 'Not stated';

// ---- the prompt ----------------------------------------------------------------------------------------------

const EXAMPLE = {
  title: 'Payment API weekly sync',
  overview: 'The team reviewed the payment API migration and agreed to ship on Friday.',
  summary: ['Migration is on track', 'Load test still pending'],
  topics: [{ title: 'Payment API migration', status: 'in progress', points: ['Staging is migrated', 'Production cut-over planned for Friday'] }],
  decisions: [{ text: 'Ship the migration on Friday if the load test passes', at: '12:40' }],
  actions: [{ text: 'Run the load test on staging', owner: 'Amal Raj', due: 'Thursday', at: '13:05', quote: 'Amal, please run the load test' }],
  risks: [{ text: 'The load test environment is shared with QA', at: '14:10' }],
  questions: [{ text: 'Who approves the cut-over?', at: '15:00' }],
  next: [{ text: 'Review again on Monday 10:00', at: '' }],
};

export function structuredSystem(language, { languages = 'Hindi, English, Malayalam' } = {}) {
  return `You write Minutes of Meeting (MOM) from raw transcripts of online meetings held in ${languages}, or a mix of them (for example Hinglish or Manglish). You return the minutes as ONE JSON document; software turns it into the finished minutes.

${TRANSCRIPT_NOTES}

${INJECTION_GUARD}

${NAMES_RULES}

${COMPLETENESS_RULES.replace('Decisions, Action Items or Open Questions', '"decisions", "actions" or "questions"')}

For each action: ${OWNER_DUE_RULES}

Every decision, action, risk and question has "at": the time of the transcript line it came from, written like the transcript's own stamps, "mm:ss" or "h:mm:ss" (for example "12:40"). Use "" when you cannot tell. An action's "quote" is at most 12 words copied from the transcript.

Write every string in ${language}. Keep names, product names, numbers, dates and technical terms exactly as said. Record only what the transcript supports. When something is ambiguous, keep it and mark it "(unclear)" rather than guessing, and never invent owners or deadlines.

Output ONLY one JSON object, in exactly this shape. No Markdown, no code fences, no commentary before or after it. Use empty arrays where nothing applies. Escape double quotes and line breaks inside strings (write \\" and \\n), or avoid them: the JSON must be valid.
{
  "title": "short meeting title",
  "overview": "two or three sentences: what the meeting was for, what came out of it",
  "summary": ["3 to 6 bullets covering the main outcomes"],
  "topics": [{ "title": "one per workstream or topic: put EVERYTHING said about it here", "status": "done | in progress | blocked | waiting on someone (a few words)", "points": ["concise points with the figures, dates, names and viewpoints"] }],
  "decisions": [{ "text": "everything agreed, closed, put on hold, approved or made conditional", "at": "mm:ss" }],
  "actions": [{ "text": "...", "owner": "name, Team or Not stated", "due": "date said or Not stated", "at": "mm:ss", "quote": "at most 12 words" }],
  "risks": [{ "text": "what is waiting on someone or something, or could delay the work", "at": "mm:ss" }],
  "questions": [{ "text": "open questions and follow-ups", "at": "mm:ss" }],
  "next": [{ "text": "dates, times or events mentioned for follow-up, and the next meeting", "at": "" }]
}

Example of a valid reply:
${JSON.stringify(EXAMPLE)}

Do not write an attendance section or notes about the recording: they are added automatically.`;
}

// Same content as the classic user prompt (header, names, attendees, notes, transcript, checklist) plus, when open
// action items of the previous meeting are carried over, the block and the extra key they need.
export function structuredUser(meeting, settings, notes, ctx = {}) {
  return withCarry(buildUserPrompt(meeting, settings, notes, ctx), ctx.carry, 'structured');
}

const CARRY_ASK = {
  structured: 'Add one more key to the JSON: "previous": [{ "id": "<the id given above>", "status": "done" | "open" | "not mentioned", "note": "what was said, in a few words" }], one entry for each item listed above. Use "done" only when the meeting reported it as finished.',
  classic: 'Write a "## Previous Action Items" section right after the Summary, with the table | # | Action | Owner | Due | Status |. Use the item\'s number from the list above in the # column and exactly one of Done, Open or Not mentioned in Status. Use Done only when the meeting reported it as finished.',
};

export function carryPrompt(carry, engine = 'structured') {
  if (!carry?.open?.length) return '';
  return `${carryText({ title: carry.prevTitle, date: carry.prevDate }, carry.open)}\n${CARRY_ASK[engine]}`;
}

export function withCarry(base, carry, engine) {
  const block = carryPrompt(carry, engine);
  if (!block) return base;
  // before the transcript, like the other facts
  return base.includes('<transcript>') ? base.replace('<transcript>', `${block}\n\n<transcript>`) : `${base}\n\n${block}`;
}

// The completeness check found points missing from the minutes: the same JSON comes back with them added.
export function structuredFixSystem(language, opts) {
  return `${structuredSystem(language, opts)}

You are now EDITING minutes you were given as JSON. A list of points that were said in the meeting but are missing from them follows. Return the full JSON with EVERY missing point added in the right list (a main outcome also in "summary"; discussion under the right topic, or a new topic only if none fits; decisions; actions with owner and due; risks; questions; next). Do not remove, shorten or reword anything already there, do not add anything that is not in the missing list, keep the "at" times. Output only the JSON object.`;
}

export function structuredFixUser(items, missing) {
  return ['<minutes_json>', JSON.stringify(forModel(items)), '</minutes_json>', '', '<missing>', ...missing, '</missing>'].join('\n');
}

// The items without the bookkeeping fields the model never wrote.
export function forModel(items) {
  const { previous, ...rest } = items || {};
  const strip = (a) => ({ text: a.text, owner: a.owner, due: a.due, at: a.at, quote: a.quote });
  return { ...rest, actions: (items?.actions || []).map(strip) };
}

// ---- reading the model's reply ------------------------------------------------------------------------------

const tryParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

// Walks the text outside strings only. Returns the cleaned text: raw line breaks inside strings escaped, trailing
// commas removed, and (quotes: true) a stray " inside a string escaped when it is not followed by , } ] or :.
function tidy(s, { quotes = false } = {}) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === '\\') {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (quotes && j < s.length && !/[,}\]:]/.test(s[j])) out += '\\"';
        else {
          out += ch;
          inStr = false;
        }
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') continue;
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '}' || ch === ']') {
      let k = out.length;
      while (k > 0 && /\s/.test(out[k - 1])) k--;
      if (out[k - 1] === ',') out = out.slice(0, k - 1);
      out += ch;
    } else out += ch;
  }
  return out;
}

// A reply that was cut off: close the open string, array and object so what was written still parses.
function closeUp(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out = (esc ? out.slice(0, -1) : out) + '"';
  out = out.replace(/[\s,]+$/, '');
  if (out.endsWith(':')) out += 'null';
  return out + stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
}

// Where the last element of the innermost open list ends, when the text stops inside that list: everything after it is a
// half-written element (an action cut mid-string would otherwise come back as "Send"). -1 when no list is open.
function lastWhole(s) {
  const stack = []; // { ch, end }: end = index after the last element of a list that was finished
  let inStr = false;
  let esc = false;
  let strDepth = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        if (stack.at(-1)?.ch === '[' && strDepth === stack.length) stack.at(-1).end = i + 1; // a string element of the list
      }
    } else if (ch === '"') {
      inStr = true;
      strDepth = stack.length;
    } else if (ch === '{' || ch === '[') stack.push({ ch, end: i + 1 });
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.at(-1)?.ch === '[') stack.at(-1).end = i + 1;
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].ch === '[') return stack[k].end;
  return -1;
}

// Best effort: drop a half-written last element and close what is left; else close the tail as it is; if that does not
// parse (a key without a value, half a number), cut back to the previous comma or bracket and close again.
function parseTruncated(s) {
  const end = lastWhole(s);
  if (end > 0) {
    const whole = tryParse(closeUp(s.slice(0, end)));
    if (whole !== undefined) return whole;
  }
  const first = tryParse(closeUp(s));
  if (first !== undefined) return first;
  const marks = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === ',' || ch === '{' || ch === '[') marks.push(i);
  }
  for (let k = marks.length - 1; k >= 0 && k >= marks.length - 80; k--) {
    const at = marks[k];
    const v = tryParse(closeUp(s[at] === ',' ? s.slice(0, at) : s.slice(0, at + 1)));
    if (v !== undefined) return v;
  }
  return undefined;
}

// From the first { to its matching }: text around it (a preamble, fences, a closing remark) is dropped.
const cleanReply = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
function objectText(text, from = 0) {
  const t = cleanReply(text);
  const start = t.indexOf('{', from);
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return t.slice(start, i + 1);
  }
  return t.slice(start); // never closed: the reply was cut off
}
const objectClosed = (raw) => {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of raw) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return true;
  }
  return false;
};

const smartKeys = (s) => s.replace(/[“”„]([A-Za-z_][\w ]{0,30})[“”„]\s*:/g, '"$1":');
const smartValues = (s) => s.replace(/([:[,]\s*)[“”„]([^“”„\n]*)[“”„](\s*[,\]}])/g, '$1"$2"$3');

// The note llm.js used to append to a reply that hit the length limit (and older stored replies still carry).
const CUT_NOTE = /\s*_\(Output hit the length limit and was cut off\.\)_\s*$/;

// { value, truncated }: truncated when the object never closed (the reply was cut off), whatever the provider said.
function parseLoose(text) {
  const clean = cleanReply(String(text || '').replace(CUT_NOTE, ''));
  // Every top-level "{" in turn: a brace in prose before the JSON ("here is the {minutes}:") must not hide it.
  // The first candidate that parses into minutes wins; else the first one that parsed at all (as before).
  let firstGood = null;
  let first = null;
  for (let from = 0, n = 0; n < 25; n++) {
    const at = clean.indexOf('{', from);
    if (at < 0) break;
    const raw = objectText(clean, at);
    from = raw && objectClosed(raw) ? at + raw.length : at + 1; // an unclosed brace: the next one may be the real start
    if (!raw) continue;
    const r = parseOne(raw);
    first ||= r;
    if (r.value !== undefined && normalizeStructured(r.value)) {
      firstGood = r;
      break;
    }
  }
  return firstGood || first || { value: undefined, truncated: false };
}
function parseOne(raw) {
  const truncated = !objectClosed(raw);
  for (const attempt of truncated ? [] : [raw, tidy(raw), tidy(smartKeys(raw)), tidy(smartValues(smartKeys(raw)), { quotes: true })]) {
    const v = tryParse(attempt);
    if (v !== undefined) return { value: v, truncated };
  }
  return { value: parseTruncated(tidy(smartKeys(raw))) ?? parseTruncated(tidy(smartValues(smartKeys(raw)), { quotes: true })), truncated };
}

const keyOf = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (o, aliases) => {
  if (!o || typeof o !== 'object') return undefined;
  const map = new Map(Object.keys(o).map((k) => [keyOf(k), k]));
  for (const a of aliases) if (map.has(a) && o[map.get(a)] != null) return o[map.get(a)];
  return undefined;
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
function str(v, cap = MAX_TEXT) {
  let t = '';
  if (typeof v === 'string') t = v;
  else if (typeof v === 'number' && Number.isFinite(v)) t = String(v);
  else if (Array.isArray(v)) t = v.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).filter(Boolean).join('; ');
  return clip(t.replace(/\s+/g, ' ').trim(), cap);
}

export const fmtAt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// "[12:40]", "12:40", "1:02:03", 760 or "760" -> seconds, else null
export function parseAt(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.floor(Number(t));
  const m = /(\d{1,3}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return null;
  return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}
const normAt = (v) => {
  const s = parseAt(v);
  return s == null ? '' : fmtAt(s);
};

const EMPTY_OWNER = /^[-–—]*$|^(none|n\/a|na|null|nil|unknown|unassigned|tbd|not (stated|specified|assigned|mentioned|known))\.?$/i;
const TEAM = /^(team|the team|everyone|everybody|all|all of us|whole team|all attendees|all participants)\.?$/i;
const EMPTY_DUE = /^[-–—]*$|^(none|n\/a|na|null|nil|tbd|unspecified|no deadline|not (stated|specified|mentioned|given))\.?$/i;

function ownerOf(v) {
  const t = str(v, 120);
  if (EMPTY_OWNER.test(t)) return NOT_STATED;
  return TEAM.test(t) ? 'Team' : t;
}
const dueOf = (v) => {
  const t = str(v, 80);
  return EMPTY_DUE.test(t) ? NOT_STATED : t;
};
const quoteOf = (v) => str(v, 300).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')).filter((l) => l.trim());
  return [];
};
const TEXT_KEYS = ['text', 'action', 'task', 'decision', 'item', 'title', 'description', 'question', 'risk', 'point', 'name', 'content', 'summary'];

function itemOf(x) {
  if (typeof x === 'string' || typeof x === 'number') return { text: str(x), at: '' };
  if (!x || typeof x !== 'object') return null;
  const text = str(pick(x, TEXT_KEYS));
  if (!text) return null;
  return { text, at: normAt(pick(x, ['at', 'time', 'timestamp', 't', 'ts', 'timecode', 'when'])) };
}
function actionOf(x) {
  const base = itemOf(x);
  if (!base) return null;
  const o = typeof x === 'object' ? x : {};
  return {
    text: base.text,
    owner: ownerOf(pick(o, ['owner', 'responsibility', 'responsible', 'assignee', 'assignedto', 'assigned', 'who', 'person'])),
    due: dueOf(pick(o, ['due', 'deadline', 'duedate', 'by', 'dueby'])),
    at: base.at,
    quote: quoteOf(pick(o, ['quote', 'evidence', 'sourcequote', 'source'])),
  };
}
function topicOf(x) {
  if (typeof x === 'string') return x.trim() ? { title: str(x), status: '', points: [] } : null;
  if (!x || typeof x !== 'object') return null;
  const points = asList(pick(x, ['points', 'bullets', 'details', 'discussion', 'notes', 'items'])).map((p) => str(typeof p === 'object' && p ? pick(p, TEXT_KEYS) : p)).filter(Boolean).slice(0, MAX_LIST);
  const title = str(pick(x, ['title', 'topic', 'name', 'heading', 'workstream']), 200);
  if (!title && !points.length) return null;
  return { title: title || 'Discussion', status: str(pick(x, ['status', 'state']), 80), points };
}

const KNOWN_KEYS = ['overview', 'summary', 'topics', 'decisions', 'actions', 'actionitems', 'tasks', 'discussion'];
const hasKnown = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).some((k) => KNOWN_KEYS.includes(keyOf(k)));

// A parsed JSON value -> the documented shape, or null when it holds nothing usable.
export function normalizeStructured(value) {
  let o = value;
  if (!hasKnown(o)) o = o && typeof o === 'object' && !Array.isArray(o) ? Object.values(o).find(hasKnown) : null; // { "minutes": { ... } }
  if (!o) return null;
  const list = (aliases, fn) => asList(pick(o, aliases)).map(fn).filter(Boolean).slice(0, MAX_LIST);
  const noAt = (x) => itemOf(x);
  const out = {
    overview: str(pick(o, ['overview', 'synopsis', 'abstract', 'description']), 1500),
    summary: list(['summary', 'keypoints', 'highlights', 'outcomes'], (x) => str(typeof x === 'object' && x ? pick(x, TEXT_KEYS) : x)).filter(Boolean),
    topics: list(['topics', 'discussion', 'sections', 'workstreams'], topicOf),
    decisions: list(['decisions'], noAt),
    actions: list(['actions', 'actionitems', 'tasks', 'todos'], actionOf),
    risks: list(['risks', 'risksandblockers', 'blockers'], noAt),
    questions: list(['questions', 'openquestions', 'followups', 'openquestionsfollowups'], noAt),
    next: list(['next', 'nextsteps', 'nextcheckpoints', 'checkpoints'], (x) => {
      const it = itemOf(x);
      return it && { text: it.text, ...(it.at ? { at: it.at } : {}) };
    }),
  };
  const title = str(pick(o, ['title', 'meetingtitle', 'name']), 200);
  if (title) out.title = title;
  const previous = pick(o, ['previous', 'previousactions', 'previousactionitems', 'review']);
  if (Array.isArray(previous)) out.previous = previous.filter((p) => p && typeof p === 'object').slice(0, MAX_LIST);
  if (!out.overview && !out.topics.length && !out.actions.length && !out.decisions.length) return null;
  return out;
}

// The model's reply -> items, or null when there is no usable object (the caller then writes the classic way).
export function parseStructured(text) {
  return parseStructuredReply(text).items;
}

// The same, saying whether the reply was cut off: { items, truncated }. A cut-off reply loses its half-written last item.
export function parseStructuredReply(text) {
  const { value, truncated } = parseLoose(text);
  return { items: value === undefined ? null : normalizeStructured(value), truncated };
}

// ---- guards ---------------------------------------------------------------------------------------------------

const IMG = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi;
const TAG = /<\/?[a-z][^>]*>/gi;
const LATIN = /[A-Za-z]/;
const normName = (s) => wordsOf(s).join(' ');

const rosterOf = ({ attendees = [], absent = [], known = [] }) => {
  const names = [...attendees, ...absent, ...(Array.isArray(known) ? known : known?.names || [])].map((n) => String(n || '').trim()).filter(Boolean);
  return [...new Map(names.map((n) => [normName(n), n])).values()];
};

// The attendee spelling for a name, when one exact or one clear first-name match exists; else null.
function rosterName(part, roster) {
  const exact = roster.find((n) => normName(n) === normName(part));
  if (exact) return exact;
  const hits = roster.map((n) => ({ n, s: nameMatch(n, part) })).filter((x) => x.s > 0);
  if (!hits.length) return null;
  const best = Math.max(...hits.map((h) => h.s));
  const top = hits.filter((h) => h.s === best);
  return new Set(top.map((h) => normName(h.n))).size === 1 ? top[0].n : null;
}

const TITLES = /^(?:(?:dr|mr|mrs|ms|miss|mx|shri|smt|sri|prof|er)\.?(?:\s+|$))+/i;
const TITLE_WORDS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'shri', 'smt', 'sri', 'prof', 'er']);
const NON_LATIN = /(?![A-Za-z\u00C0-\u024F])\p{L}/u;
// "Rahul" and "राहुल" share a skeleton (src/ask.js): the same name said in another script. Very short skeletons match too much.
const skeleton = (w) => {
  const f = foldToken(w);
  return f.length >= 3 ? f : '';
};

export function guardStructured(items, { transcript = '', attendees = [], absent = [], known = [], entries = [], learned = [], durationSec } = {}) {
  const lines = String(transcript).split('\n');
  const lineSec = lines.map((l) => {
    const m = /^\s*\[([\d:]+)\]/.exec(l);
    return m ? parseAt(m[1]) : null;
  });
  const lineWords = lines.map((l) => ` ${wordsOf(l).join(' ')} `);
  const all = ` ${wordsOf(transcript).join(' ')} `;
  const lower = String(transcript).toLowerCase();
  const lastStamp = Math.max(0, ...lineSec.filter((x) => x != null));
  const bound = Math.max(durationSec || 0, lastStamp) > 0 ? Math.max(durationSec || 0, lastStamp) + 90 : Infinity;
  // the known roster: attendees, absent invitees, known names, the dictionary's names and the names learned from meetings
  const roster = rosterOf({ attendees, absent, known: [...(Array.isArray(known) ? known : known?.names || []), ...(entries || []).map((e) => e?.name), ...(learned || [])] });
  const skel = (hay) => new Set(hay.split(' ').map(skeleton).filter(Boolean));
  const absentNames = absent.map((n) => normName(n));

  const inTranscript = (u) => lower.includes(u.toLowerCase().replace(/[.,;:!?]+$/, ''));
  const clean = (s) =>
    String(s ?? '')
      .replace(IMG, (_, alt) => alt)
      .replace(LINK, (m, txt, url) => (inTranscript(url) ? m : txt))
      .replace(URL_RE, (u) => (inTranscript(u) ? u : ''))
      .replace(TAG, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

  const atOk = (at) => {
    const s = parseAt(at);
    return s != null && s <= bound ? fmtAt(s) : '';
  };

  // the lines an item came from (by its time, or by its quote), with one line either side
  const windowOf = (it) => {
    const idx = new Set();
    const s = parseAt(it.at);
    if (s != null) lineSec.forEach((x, i) => x != null && Math.abs(x - s) <= 5 && idx.add(i));
    const q = wordsOf(it.quote || '').slice(0, 12).join(' ');
    if (q) lineWords.forEach((w, i) => w.includes(` ${q} `) && idx.add(i));
    if (!idx.size) return null;
    const near = new Set();
    for (const i of idx) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) near.add(j);
    return [...near].map((j) => lineWords[j]).join(' ');
  };
  // a wider stretch for telling whether the item was said in another script: its time ±60 s, else the quote's lines
  const scriptWindowOf = (it, win) => {
    const s = parseAt(it.at);
    if (s == null) return win;
    const near = lineWords.filter((_, i) => lineSec[i] != null && Math.abs(lineSec[i] - s) <= 60);
    return near.length ? `${near.join(' ')} ${win || ''}` : win;
  };

  // An owner must be an attendee or known name, or be said in the transcript next to the item. Otherwise it becomes
  // "Not stated" and the model's wording is kept in ownerDropped: the item itself is never thrown away.
  const guardOwner = (it) => {
    const owner = it.owner;
    if (!owner || owner === NOT_STATED || owner === 'Team') return it;
    const win = windowOf(it);
    const wide = scriptWindowOf(it, win);
    const keep = [];
    let dropped = false;
    for (const part of owner.split(/\s*(?:,|;|&|\/|\band\b|\+)\s*/i).map((p) => p.trim()).filter(Boolean)) {
      if (/^(me|others|room|unknown speaker)$/i.test(part)) {
        dropped = true;
        continue;
      }
      if (TEAM.test(part)) {
        keep.push('Team');
        continue;
      }
      const bare = part.replace(TITLES, '').trim() || part; // "Dr Rahul" is the person "Rahul"
      const name = rosterName(part, roster) || rosterName(bare, roster);
      if (name) {
        keep.push(name);
        continue;
      }
      const tokens = wordsOf(bare).filter((w) => !TITLE_WORDS.has(w));
      const first = tokens[0];
      if (!first) {
        dropped = true;
        continue;
      }
      const hay = win ?? all; // the item could not be located: the name must at least be said somewhere
      // a Latin name cannot be compared with Devanagari or Malayalam text: kept when the item's stretch has any (a mixed
      // line "राहुल, तुम staging पर…"), or, for an item that could not be located, when the whole transcript has no Latin
      const otherScript = LATIN.test(first) && (wide ? NON_LATIN.test(wide) : !LATIN.test(all));
      const ok = otherScript || tokens.some((w) => hay.includes(` ${w} `) || (skeleton(w) && skel(hay).has(skeleton(w))));
      if (ok) keep.push(part);
      else dropped = true;
    }
    const uniq = [...new Set(keep)];
    const next = uniq.length ? uniq.join(', ') : NOT_STATED;
    const out = { ...it, owner: next };
    if (dropped || !uniq.length) out.ownerDropped = owner; // respelling an owner is not dropping one
    if (uniq.some((n) => absentNames.includes(normName(n)))) out.ownerAbsent = true;
    return out;
  };

  const guardQuote = (q) => {
    const words = String(q || '').split(/\s+/).filter(Boolean).slice(0, 12);
    if (!words.length) return '';
    if (all.trim() && !all.includes(` ${wordsOf(words.join(' ')).join(' ')} `)) return ''; // not in the transcript: it was made up
    return words.join(' ');
  };

  const key = (t) => normName(t) || String(t).toLowerCase();
  const dedupe = (list, merge) => {
    const seen = new Map();
    const out = [];
    for (const it of list) {
      const k = key(it.text);
      if (!seen.has(k)) {
        seen.set(k, out.length);
        out.push(it);
      } else if (merge) out[seen.get(k)] = merge(out[seen.get(k)], it);
    }
    return out;
  };
  const fillBlank = (a, b) => ({
    ...a,
    owner: a.owner === NOT_STATED && b.owner !== NOT_STATED ? b.owner : a.owner,
    due: a.due === NOT_STATED && b.due !== NOT_STATED ? b.due : a.due,
    at: a.at || b.at,
    quote: a.quote || b.quote,
  });

  const out = { ...items };
  if (out.title) out.title = clean(out.title);
  out.overview = clean(out.overview);
  out.summary = dedupe((items.summary || []).map((s) => ({ text: clean(s) })).filter((x) => x.text)).map((x) => x.text);
  const topics = (items.topics || [])
    .map((t) => ({ title: clean(t.title), status: clean(t.status), points: dedupe((t.points || []).map((p) => ({ text: clean(p) })).filter((x) => x.text)).map((x) => x.text) }))
    .filter((t) => t.title || t.points.length);
  const byTitle = new Map();
  out.topics = [];
  for (const t of topics) {
    const k = key(t.title);
    const at = byTitle.get(k);
    if (at === undefined) {
      byTitle.set(k, out.topics.length);
      out.topics.push(t);
    } else {
      const cur = out.topics[at];
      out.topics[at] = { ...cur, status: cur.status || t.status, points: dedupe([...cur.points, ...t.points].map((p) => ({ text: p }))).map((x) => x.text) };
    }
  }
  const base = (list) => (list || []).map((x) => ({ ...x, text: clean(x.text), at: atOk(x.at) })).filter((x) => x.text);
  out.decisions = dedupe(base(items.decisions));
  out.risks = dedupe(base(items.risks));
  out.questions = dedupe(base(items.questions));
  out.next = dedupe(base(items.next).map((x) => (x.at ? x : { text: x.text })));
  out.actions = dedupe(
    base(items.actions).map((a) => guardOwner({ ...a, owner: clean(a.owner) || NOT_STATED, due: clean(a.due) || NOT_STATED, quote: guardQuote(clean(a.quote)) })),
    fillBlank
  );
  if (items.previous) out.previous = items.previous.map((p) => ({ ...p, note: clean(p.note) }));
  return out;
}

// ---- stable ids -----------------------------------------------------------------------------------------------

function hash(text) {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2 + c) | 0;
  }
  return `a${(((h1 >>> 0) ^ (h2 >>> 0)) >>> 0).toString(36).padStart(6, '0').slice(0, 6)}`;
}
export const actionHash = (a) => hash(`${normName(a.text)}|${a.at || ''}`);

const similarity = (a, b) => {
  const x = new Set(wordsOf(a));
  const y = new Set(wordsOf(b));
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
};

// Each action gets a short id (a hash of its text and time) and a status. A rewrite of the same minutes keeps the ids,
// and the status/doneAt/doneBy of the previous structured object of the SAME meeting is carried over (also when the model
// reworded an action a little: the same time with similar words, or nearly the same words).
export function assignIds(items, prev) {
  const before = (prev?.actions || []).filter((a) => a.id);
  const used = new Set();
  const take = new Map(); // new action index -> previous action
  const actions = items.actions || [];
  actions.forEach((a, i) => {
    const p = before.find((x) => !used.has(x.id) && x.id === (a.id || actionHash(a)));
    if (p) {
      used.add(p.id);
      take.set(i, p);
    }
  });
  actions.forEach((a, i) => {
    if (take.has(i)) return;
    let best = null;
    let bestScore = 0;
    for (const p of before) {
      if (used.has(p.id)) continue;
      const s = similarity(a.text, p.text);
      if ((s >= 0.7 || (a.at && a.at === p.at && s >= 0.4)) && s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    if (best) {
      used.add(best.id);
      take.set(i, best);
    }
  });
  const ids = new Set(before.map((p) => p.id));
  const out = actions.map((a, i) => {
    const p = take.get(i);
    let id = p?.id || a.id || actionHash(a);
    if (!p) for (let n = 2; ids.has(id) && !(a.id && a.id === id); n++) id = `${actionHash(a)}${n}`;
    ids.add(id);
    const status = p?.status || a.status || 'open';
    const { doneAt: _d, doneBy: _b, ...rest } = a;
    const doneAt = status === 'done' ? p?.doneAt ?? a.doneAt : undefined;
    const doneBy = status === 'done' ? (p ? p.doneBy : a.doneBy) : undefined; // closed by a later meeting: still is after a rewrite
    return { ...rest, id, status, ...(doneAt != null ? { doneAt } : {}), ...(doneBy != null ? { doneBy } : {}) };
  });
  return { ...items, actions: out };
}

// ---- Markdown ---------------------------------------------------------------------------------------------------

const cell = (s) => String(s ?? '').replace(/\\*\|/g, '\\|').replace(/\r?\n/g, ' ').trim(); // a pipe is escaped once, whatever backslashes came before it
const line = (s) => String(s ?? '').replace(/\r?\n/g, ' ').trim();

// items -> the Markdown the classic prompt asks the model for, with the header line built by code.
// meeting: the record; attendees: names for the Participants line; carry: { open } and review: [{ id, status }]
// when open action items of the previous meeting were carried over.
export function renderMinutes(items, { meeting = {}, attendees = [], evidence = true, carry = null, review = [] } = {}) {
  const L = [`# ${line(items.title || meeting.title || 'Meeting minutes')}`];
  const head = [];
  if (Number.isFinite(meeting.startedAt)) head.push(`**Date:** ${new Date(meeting.startedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`);
  if (Number.isFinite(meeting.startedAt) && Number.isFinite(meeting.endedAt)) head.push(`**Duration:** ${Math.round((meeting.endedAt - meeting.startedAt) / 60000)} min`);
  if (attendees.length) head.push(`**Participants (as identified):** ${attendees.join(', ')}`);
  if (head.length) L.push(head.join(' · '));
  if (items.overview) L.push('', '## Overview', line(items.overview));
  if (items.summary?.length) L.push('', '## Summary', ...items.summary.map((s) => `- ${line(s)}`));
  const prev = carry?.open?.length ? reviewSection(carry.open, review) : '';
  if (prev) L.push('', prev);
  if (items.topics?.length) {
    L.push('', '## Discussion');
    for (const t of items.topics) {
      L.push('', `### ${line(t.title)}`);
      if (t.status) L.push(`**Status:** ${line(t.status)}`);
      for (const p of t.points) L.push(`- ${line(p)}`);
    }
  }
  if (items.decisions?.length) L.push('', '## Decisions', ...items.decisions.map((d) => `- ${line(d.text)}${evidence && d.at ? ` [${d.at}]` : ''}`));
  L.push('', '## Action Items');
  L.push(...(evidence ? ['| # | Action | Owner | Due | Source |', '|---|--------|-------|-----|--------|'] : ['| # | Action | Owner | Due |', '|---|--------|-------|-----|']));
  const src = (a) => (a.at && a.quote ? `[${a.at}] "${a.quote}"` : a.at ? `[${a.at}]` : a.quote ? `"${a.quote}"` : '—');
  if (items.actions?.length) {
    items.actions.forEach((a, i) => {
      const owner = `${a.owner || NOT_STATED}${a.ownerAbsent ? ' (not present)' : ''}`;
      const cells = [i + 1, `${a.text}${a.status === 'done' ? ' (done)' : ''}`, owner, a.due || NOT_STATED];
      if (evidence) cells.push(src(a));
      L.push(`| ${cells.map(cell).join(' | ')} |`);
    });
  } else L.push(`| — | None recorded. | — | — |${evidence ? ' — |' : ''}`);
  if (items.risks?.length) L.push('', '## Risks and Blockers', ...items.risks.map((r) => `- ${line(r.text)}`));
  if (items.questions?.length) L.push('', '## Open Questions / Follow-ups', ...items.questions.map((q) => `- ${line(q.text)}`));
  if (items.next?.length) L.push('', '## Next Checkpoints', ...items.next.map((n) => `- ${line(n.text)}`));
  return L.join('\n');
}

// ---- items from Markdown / the organisation template ---------------------------------------------------------------

const STAMP = /\[((?:\d+:)?\d{1,2}:\d{2})\]/;
const plain = (s) => String(s ?? '').replace(/\*\*|__|`/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
const isSepRow = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');

function mdSections(md) {
  const out = [];
  let cur = null;
  for (const l of String(md || '').split(/\r?\n/)) {
    const h = /^(#{2,3})\s+(.*)$/.exec(l);
    if (h) {
      cur = { level: h[1].length, title: h[2].trim(), lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(l);
  }
  return out;
}
const bulletsOf = (lines) => lines.map((l) => /^\s*[-*•]\s+(.*)$/.exec(l)?.[1]).filter(Boolean).map(plain).filter(Boolean);

// Classic engine: the minutes only exist as Markdown. Reads what a program can use (actions, decisions, risks,
// questions, next checkpoints, topics, overview) back into the structured shape. null when nothing could be read.
export function itemsFromMarkdown(md) {
  const secs = mdSections(md);
  const h2 = (re) => secs.filter((s) => s.level === 2 && re.test(s.title.toLowerCase()));
  const items = { overview: '', summary: [], topics: [], decisions: [], actions: [], risks: [], questions: [], next: [] };
  const title = /^#\s+(.+)$/m.exec(String(md || ''))?.[1];
  if (title && !/^#/.test(title)) items.title = plain(title);
  items.overview = plain(h2(/^overview/).flatMap((s) => s.lines).join(' '));
  items.summary = h2(/^summary/).flatMap((s) => bulletsOf(s.lines));
  const disc = secs.findIndex((s) => s.level === 2 && /^discussion/i.test(s.title));
  if (disc >= 0) {
    for (let i = disc + 1; i < secs.length && secs[i].level === 3; i++) {
      const rest = secs[i].lines.filter((l) => l.trim());
      const first = rest.find((l) => !/^\s*[-*•]\s/.test(l));
      const status = first ? plain(first).replace(/^_?status:?\s*/i, '').replace(/^_|_$/g, '') : '';
      items.topics.push({ title: plain(secs[i].title), status, points: bulletsOf(rest) });
    }
  }
  items.decisions = h2(/^decisions/).flatMap((s) => bulletsOf(s.lines)).map((b) => {
    const m = STAMP.exec(b.slice(-14));
    return { text: plain(m ? b.replace(STAMP, '').replace(/\s*\.?\s*$/, '') : b), at: m ? normAt(m[1]) : '' };
  }).filter((d) => d.text);
  for (const s of h2(/^action/)) {
    const rows = s.lines.filter((l) => l.trim().startsWith('|'));
    if (rows.length < 2) continue;
    const head = splitRow(rows[0]).map((c) => plain(c).toLowerCase());
    const col = (re) => head.findIndex((c) => re.test(c));
    const [iText, iOwner, iDue, iSrc] = [col(/action/), col(/owner|responsib/), col(/due|deadline/), col(/source|time/)];
    for (const r of rows.slice(1)) {
      if (isSepRow(r)) continue;
      const c = splitRow(r);
      const text = plain(c[iText >= 0 ? iText : 1] ?? c[0]).replace(/\s*\(done\)$/i, '');
      if (!text || /^none recorded/i.test(text)) continue;
      const source = iSrc >= 0 ? String(c[iSrc] ?? '') : '';
      items.actions.push({
        text,
        owner: ownerOf(iOwner >= 0 ? plain(c[iOwner]).replace(/\s*\(not present\)$/i, '') : ''),
        due: dueOf(iDue >= 0 ? plain(c[iDue]) : ''),
        at: normAt(STAMP.exec(source)?.[1] || ''),
        quote: quoteOf((/["“]([^"”]+)["”]/.exec(source) || [])[1] || ''),
      });
    }
  }
  items.risks = h2(/^risks/).flatMap((s) => bulletsOf(s.lines)).map((text) => ({ text, at: '' }));
  items.questions = h2(/^open questions/).flatMap((s) => bulletsOf(s.lines)).map((text) => ({ text, at: '' }));
  items.next = h2(/^next/).flatMap((s) => bulletsOf(s.lines)).map((text) => ({ text }));
  const found = items.actions.length || items.decisions.length || items.topics.length || items.overview;
  return found ? items : null;
}

const BY_DATE = /\bby\s+(\d{1,2}[-\s/][A-Za-z]{3,9}[-\s/]\d{2,4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\.?\s*$/i;

// Organisation template format: the formal minutes keep their own dedicated model call (their register is a product
// requirement), so the structured items are read from its parsed result: topics from the Discussion rows, actions with
// the Responsibility as owner and the "by DD-Mon-YY" at the end of the sentence as due date.
export function itemsFromTemplate(prose) {
  if (!prose) return null;
  const owner = (r) => (!r || r === PH.resp || /^(not applicable|n\/a|—|-)$/i.test(r) ? NOT_STATED : ownerOf(r));
  const items = {
    overview: '',
    summary: [],
    topics: (prose.discussion || []).map((d) => ({ title: str(d.topic, 200) || 'Discussion', status: '', points: (d.points || []).map((p) => str(p)).filter(Boolean) })),
    decisions: [],
    actions: (prose.actions || []).map((a) => ({ text: str(a.text), owner: owner(a.resp), due: dueOf((BY_DATE.exec(a.text) || [])[1] || ''), at: '', quote: '' })).filter((a) => a.text),
    risks: [],
    questions: [],
    next: [],
  };
  const when = prose.next?.when;
  if (when && when !== TBD) items.next.push({ text: `Next meeting: ${when}${prose.next.where && prose.next.where !== TBD ? `, ${prose.next.where}` : ''}` });
  return items.topics.length || items.actions.length ? items : null;
}

// How many entries each list holds: the second structured call (completeness) must not lose any.
export const countsOf = (items) => ({ summary: items.summary?.length || 0, topics: items.topics?.length || 0, ...Object.fromEntries(LISTS.map((k) => [k, items[k]?.length || 0])) });
