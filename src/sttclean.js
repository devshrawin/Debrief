// Cleaning what a speech model gives back, and the names it is given to spell.
//
// 1. General Gemini models sometimes "think out loud" inside the transcript: "The user wants a transcription… Rules: …
//    Audio breakdown 0:00 - 0:05: … Is it "SeVa" or "SAVI"? … Looks very solid! <the real transcript>". That is not what was
//    said. cleanTranscript() keeps what came before the thinking and the final answer after it, and drops the rest.
// 2. The same models repeat a passage several times, and write speaker labels ("Deep Patel: …") nobody asked for.
// 3. Spelling hints must be people's names, never Meet's own button text ("Backgrounds and effects", "More options for X").
import { isIconText, isMenuText, personOfTile } from './iconText.js';

// Where the thinking starts.
const LEAK_START = [
  /(?:^|[\s"“”.!?।])(?:The user (?:wants|is asking|asked|has provided)|Rules:|Audio breakdown|Let'?s (?:double-?)?check|Let'?s (?:re-?listen|hear)|Re-?listen\b|Wait, (?:is|maybe|let|the)|Is it ["“'][^"”']{1,40}["”'] or)/i,
  /\b\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*:/, // "0:00 - 0:05:" a breakdown by time
];
// Where the thinking ends and the real answer follows.
const LEAK_END = /(?:Looks (?:very )?(?:good|solid)!?|Final (?:answer|transcript|output):?|Here(?:'s| is) the (?:final )?transcript:?)\s*/gi;

export function stripThinking(text) {
  const t = String(text || '');
  let first = -1;
  for (const re of LEAK_START) {
    const m = re.exec(t);
    if (m && (first < 0 || m.index < first)) first = m.index;
  }
  if (first < 0) return { text: t, leaked: false };
  const before = t.slice(0, first).trim().replace(/["“”]+$/, '').trim();
  let after = '';
  let m;
  let endAt = -1;
  LEAK_END.lastIndex = 0;
  while ((m = LEAK_END.exec(t))) if (m.index > first) endAt = m.index + m[0].length;
  if (endAt >= 0) after = t.slice(endAt).trim();
  return { text: [before, after].filter(Boolean).join(' ').trim(), leaked: true };
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

// A sentence of real length that was already said earlier in the same piece is dropped.
export function dropRepeats(text) {
  const parts = String(text || '').split(/(?<=[.!?।])\s+/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = norm(p);
    if (k.length >= 30 && seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join(' ').trim();
}

// "Deep Patel: ठीक है" -> "ठीक है", for the names we know (the model added the label itself; the line already has its speaker).
export function stripLabels(text, names = []) {
  const known = [...new Set(names.map((n) => String(n).trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  if (!known.length) return String(text || '');
  const esc = known.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(text || '').replace(new RegExp(`(^|[\\s.!?।])(?:${esc})\\s*:\\s*`, 'giu'), '$1').replace(/\s{2,}/g, ' ').trim();
}

// Everything above, in order. `names`: people we know (to strip the labels the model made up).
export function cleanTranscript(text, names = []) {
  const { text: t, leaked } = stripThinking(text);
  const clean = stripLabels(dropRepeats(t), names);
  return { text: clean, leaked, changed: clean !== String(text || '').trim() };
}

// ---- spelling hints ----------------------------------------------------------------------------------
const NOT_A_NAME = /^(?:open in new window|backgrounds? and effects|captions?|present now|chat with everyone|raise hand|leave call|turn (?:on|off) .*|more options.*|you can.*|pin|unpin|mute|unmute)$/i;

// Names and terms fit to give a speech or writing model: Meet's button text is removed, "More options for X" becomes "X".
export function cleanTerms(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const t = personOfTile(String(raw || '').trim());
    if (!t || t.length < 2 || t.length > 60) continue;
    if (isIconText(t) || isMenuText(t) || NOT_A_NAME.test(t)) continue;
    if (t.split(/\s+/).length > 5) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
