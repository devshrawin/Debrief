// Pull action items and decisions out of minutes, either the markdown src/prompt.js asks for or a structured object.
import { parseClock } from './metrics.mjs';

const STAMP = /\[(?:\d+:)?\d{1,2}:\d{2}\]/;
const clean = (s) => String(s ?? '').replace(/\*\*|__/g, '').replace(/<br\s*\/?>/gi, ' ').trim();
const atOf = (s) => { const m = STAMP.exec(String(s ?? '')); return m ? m[0].slice(1, -1) : ''; };
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const isSep = (line) => /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');

function sections(md) {
  const out = [];
  let cur = null;
  for (const line of String(md).split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) { cur = { title: h[1].trim().toLowerCase(), lines: [] }; out.push(cur); } else if (cur) cur.lines.push(line);
  }
  return out;
}
const bullets = (lines) => lines.map((l) => /^\s*[-*•]\s+(.*)$/.exec(l)?.[1]).filter(Boolean);

// "Submit the revised budget by 16-Oct-26." -> due "16-Oct-26" (the org template has no Due column)
const dueFromSentence = (t) => /\bby\s+(\d{1,2}[-\s/][A-Za-z]{3,9}[-\s/]\d{2,4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i.exec(t)?.[1] || '';

function parseActionTable(lines) {
  const rows = lines.filter((l) => l.trim().startsWith('|'));
  if (rows.length < 2) return [];
  const head = cells(rows[0]).map((c) => c.toLowerCase());
  const col = (re) => head.findIndex((c) => re.test(c));
  const iText = col(/action/), iOwner = col(/owner|responsib/), iDue = col(/due|deadline/), iSrc = col(/source|time/);
  const out = [];
  for (const row of rows.slice(1)) {
    if (isSep(row)) continue;
    const c = cells(row);
    const text = clean(c[iText >= 0 ? iText : 1] ?? c[0]);
    if (!text || /^none recorded/i.test(text)) continue;
    const owner = iOwner >= 0 ? clean(c[iOwner]) : '';
    const due = iDue >= 0 ? clean(c[iDue]) : dueFromSentence(text);
    out.push({ text, owner: /^\[?responsibility\]?$|^not applicable$/i.test(owner) ? '' : owner, due, at: iSrc >= 0 ? atOf(c[iSrc]) : '' });
  }
  return out;
}

function fromObject(o) {
  const item = (x, keys) => {
    if (typeof x === 'string') return { text: x, owner: '', due: '', at: '' };
    const text = keys.map((k) => x?.[k]).find((v) => typeof v === 'string' && v) || '';
    return { text, owner: x?.owner ?? x?.responsibility ?? '', due: x?.due ?? x?.deadline ?? '', at: x?.at ?? x?.t ?? '' };
  };
  const list = (v, keys) => (Array.isArray(v) ? v : []).map((x) => item(x, keys)).filter((x) => x.text);
  const keys = ['text', 'action', 'task', 'decision', 'title', 'question', 'risk'];
  return { actions: list(o?.actions, keys), decisions: list(o?.decisions, keys).map(({ text, at }) => ({ text, at })), risks: list(o?.risks, keys).map((x) => x.text), questions: list(o?.questions, keys).map((x) => x.text) };
}

export function parseMinutesItems(input) {
  if (input && typeof input === 'object') return fromObject(input);
  const s = String(input ?? '');
  if (/^\s*\{/.test(s)) { try { return fromObject(JSON.parse(s)); } catch {} }
  const secs = sections(s);
  const find = (re) => secs.filter((x) => re.test(x.title));
  const actions = find(/^action/).flatMap((x) => parseActionTable(x.lines));
  const decisions = find(/^decision/).flatMap((x) => bullets(x.lines)).map((b) => {
    const at = atOf(b.slice(-14));
    return { text: clean(at ? b.replace(new RegExp(`\\s*\\[${at}\\]\\s*\\.?\\s*$`), '') : b), at };
  }).filter((d) => d.text);
  const risks = find(/^risk/).flatMap((x) => bullets(x.lines)).map(clean);
  const questions = find(/^open question/).flatMap((x) => bullets(x.lines)).map(clean);
  return { actions, decisions, risks, questions };
}

export { parseClock };
