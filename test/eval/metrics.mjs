// Pure scoring functions for the golden-set harness. No I/O.

// NFKC, lowercase Latin, strip punctuation, collapse spaces. Letters, combining marks and digits survive, so
// Devanagari and Malayalam keep their vowel signs. `script` ('latin'|'devanagari'|'malayalam') drops letters of other scripts.
const SCRIPTS = { latin: /\p{Script=Latin}/u, devanagari: /\p{Script=Devanagari}/u, malayalam: /\p{Script=Malayalam}/u };
export function normalizeText(s, { script } = {}) {
  let t = String(s ?? '').normalize('NFKC').toLowerCase().replace(/[​-‍﻿'’`]/g, '');
  if (script && SCRIPTS[script]) t = [...t].filter((c) => !/\p{L}/u.test(c) || SCRIPTS[script].test(c)).join('');
  return t.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}
const tokens = (s, o) => { const n = normalizeText(s, o); return n ? n.split(' ') : []; };

// Levenshtein over two arrays, rolling rows, tracking substitutions/deletions/insertions along the best path.
function align(ref, hyp) {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => ({ c: j, s: 0, d: 0, i: j }));
  for (let r = 1; r <= ref.length; r++) {
    const cur = [{ c: r, s: 0, d: r, i: 0 }];
    for (let j = 1; j <= hyp.length; j++) {
      const sub = prev[j - 1], del = prev[j], ins = cur[j - 1];
      const eq = ref[r - 1] === hyp[j - 1];
      const a = sub.c + (eq ? 0 : 1), b = del.c + 1, c = ins.c + 1;
      if (a <= b && a <= c) cur[j] = { c: a, s: sub.s + (eq ? 0 : 1), d: sub.d, i: sub.i };
      else if (b <= c) cur[j] = { c: b, s: del.s, d: del.d + 1, i: del.i };
      else cur[j] = { c, s: ins.s, d: ins.d, i: ins.i + 1 };
    }
    prev = cur;
  }
  return prev[hyp.length];
}

export function wer(ref, hyp, opts) {
  const r = tokens(ref, opts), h = tokens(hyp, opts);
  const { s, d, i } = align(r, h);
  const edits = s + d + i;
  return { wer: r.length ? edits / r.length : h.length ? 1 : 0, sub: s, del: d, ins: i, refWords: r.length };
}

// Characters of the normalized text, spaces removed: word boundaries and spellings vary a lot in Indic scripts.
export function cer(ref, hyp, opts) {
  const r = [...normalizeText(ref, opts).replace(/ /g, '')], h = [...normalizeText(hyp, opts).replace(/ /g, '')];
  const { s, d, i } = align(r, h);
  const edits = s + d + i;
  return { cer: r.length ? edits / r.length : h.length ? 1 : 0, sub: s, del: d, ins: i, refChars: r.length, edits };
}

export function scriptShare(text) {
  const n = { latin: 0, devanagari: 0, malayalam: 0, other: 0 };
  for (const c of String(text ?? '').normalize('NFKC')) {
    if (!/\p{L}/u.test(c)) continue;
    if (SCRIPTS.latin.test(c)) n.latin++;
    else if (SCRIPTS.devanagari.test(c)) n.devanagari++;
    else if (SCRIPTS.malayalam.test(c)) n.malayalam++;
    else n.other++;
  }
  const total = n.latin + n.devanagari + n.malayalam + n.other;
  const f = (x) => (total ? x / total : 0);
  return { latin: f(n.latin), devanagari: f(n.devanagari), malayalam: f(n.malayalam), other: f(n.other), letters: total };
}

// ---- action / decision items ----
const STOP = new Set(('a an the to of and or for on in at by with is are was be will shall should would from this that it as so we you i he she they ' +
  'please also then there their them our your has have had not no do does did can could ' +
  'ka ki ke ko se me mein hai hain ho tha thi par aur ya bhi kar karna karo करना करो है हैं का की के को से में और या भी पर').split(' '));
const itemText = (x) => (typeof x === 'string' ? x : x?.text ?? x?.action ?? x?.task ?? '');
const itemToks = (x) => tokens(itemText(x)).filter((t) => !STOP.has(t));
function f1Tokens(a, b) {
  if (!a.length || !b.length) return 0;
  const cnt = new Map();
  for (const t of b) cnt.set(t, (cnt.get(t) || 0) + 1);
  let common = 0;
  for (const t of a) if (cnt.get(t) > 0) { common++; cnt.set(t, cnt.get(t) - 1); }
  if (!common) return 0;
  const p = common / b.length, r = common / a.length;
  return (2 * p * r) / (p + r);
}

export function matchItems(refItems = [], hypItems = [], { threshold = 0.4 } = {}) {
  const rt = refItems.map(itemToks), ht = hypItems.map(itemToks);
  const pairs = [];
  rt.forEach((a, i) => ht.forEach((b, j) => { const score = f1Tokens(a, b); if (score >= threshold) pairs.push({ i, j, score }); }));
  pairs.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
  const usedR = new Set(), usedH = new Set(), matched = [];
  for (const { i, j, score } of pairs) {
    if (usedR.has(i) || usedH.has(j)) continue;
    usedR.add(i); usedH.add(j);
    matched.push({ ref: refItems[i], hyp: hypItems[j], score });
  }
  const missed = refItems.filter((_, i) => !usedR.has(i));
  const extra = hypItems.filter((_, j) => !usedH.has(j));
  const both0 = !refItems.length && !hypItems.length;
  const precision = hypItems.length ? matched.length / hypItems.length : both0 ? 1 : 0;
  const recall = refItems.length ? matched.length / refItems.length : both0 ? 1 : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { matched, missed, extra, precision, recall, f1 };
}

// ---- owner / due / timestamps ----
const NONE = new Set(['', '-', '—', '–', 'not stated', 'n/a', 'na', 'none', 'tbd', 'unknown', 'not applicable', '[responsibility]']);
const isNone = (v) => NONE.has(String(v ?? '').trim().toLowerCase());
const names = (v) => String(v).split(/,|\/|&|;|\band\b/i).map((x) => normalizeText(x).split(' ')[0]).filter(Boolean);

export function ownerAccuracy(matched = []) {
  let correct = 0, wrong = 0, missing = 0;
  for (const { ref, hyp } of matched) {
    if (isNone(ref?.owner)) continue;
    if (isNone(hyp?.owner)) { missing++; continue; }
    const want = names(ref.owner), got = names(hyp.owner);
    if (got.some((g) => want.includes(g))) correct++; else wrong++;
  }
  const total = correct + wrong + missing;
  return { correct, wrong, missing, total, accuracy: total ? correct / total : null };
}

const MON = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/g;
const dueToks = (v) => normalizeText(String(v).replace(/(\d)(st|nd|rd|th)\b/gi, '$1').toLowerCase().replace(MON, '$1')).split(' ').filter(Boolean);
export function dueMatches(a, b) {
  const x = dueToks(a), y = dueToks(b);
  if (!x.length || !y.length) return false;
  const inter = x.filter((t) => y.includes(t)).length;
  return inter === Math.min(x.length, y.length) || inter / new Set([...x, ...y]).size >= 0.5;
}
export function dueAccuracy(matched = []) {
  let correct = 0, wrong = 0, missing = 0;
  for (const { ref, hyp } of matched) {
    if (isNone(ref?.due)) continue;
    if (isNone(hyp?.due)) missing++;
    else if (dueMatches(ref.due, hyp.due)) correct++;
    else wrong++;
  }
  const total = correct + wrong + missing;
  return { correct, wrong, missing, total, accuracy: total ? correct / total : null };
}

export function parseClock(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const m = /^\s*\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?\s*$/.exec(String(v ?? ''));
  return m ? (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] : null;
}
export function timestampError(matched = []) {
  const errs = [];
  for (const { ref, hyp } of matched) {
    const a = parseClock(ref?.at), b = parseClock(hyp?.at);
    if (a != null && b != null) errs.push(Math.abs(a - b));
  }
  if (!errs.length) return { n: 0, mean: null, median: null };
  const s = [...errs].sort((x, y) => x - y), mid = s.length >> 1;
  return { n: s.length, mean: errs.reduce((x, y) => x + y, 0) / s.length, median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 };
}
