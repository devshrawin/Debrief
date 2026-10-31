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
  return balanceQuotes(String(text || '').replace(new RegExp(`(^|[\\s.!?।])(?:${esc})\\s*:\\s*["“]?`, 'giu'), '$1').replace(/\s{2,}/g, ' ').trim());
}

// A quote mark whose partner was removed with a label (Akash: "Correct. Okay." -> Correct. Okay.") would be left dangling.
function balanceQuotes(text) {
  let t = String(text || '');
  if ((t.match(/"/g) || []).length % 2) t = t.replace(/"/g, '');
  if ((t.match(/[“”]/g) || []).length % 2) t = t.replace(/[“”]/g, '');
  return t;
}

// ---- notes the model writes about the audio instead of (or around) the words --------------------------------
// "Silent audio track…", "Analyse the audio: - 00:00 - 00:46: Male speaker…", "Keywords to check: …", "- Output: Nothing".
// These sit on lines of their own, sometimes with the real words glued to the end of the last one.
const NOTE_LINE = [
  /^\s*(?:[-*•]\s+)?(?:Silent audio track|Output:|Analy[sz]e the audio|Keywords? to check|(?:Malayalam |Hindi )?transcription check|English context with|Audio (?:analysis|summary|breakdown))/i,
  /^\s*(?:[-*•]\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*[-–]\s*\d{1,2}:\d{2}/, // "00:48 - 01:00: ..." a breakdown by time
  /^\s*[-*•]\s+["“]/, // a bullet that quotes speech (the same words follow as plain text)
  /^\s*(?:[-*•]\s+)?(?:Speaker \d+|(?:Fe)?male(?: voice| speaker)?(?: \d)?)\s*(?:\([^)]*\))?\s*:\s*["“][^"”]*["”]\s*\([^)]*\)\s*$/i, // Female 1: "ധന്യ" (Dhanya?)  a quote with its romanised gloss
];
// a romanised gloss the model adds after Malayalam, Hindi or Tamil text: ഇത് ഇങ്ങനെ? (Ith inganeyokke?)
const GLOSS = /([ऀ-ॿ஀-௿ഀ-ൿ][.?!"”]*)\s*\([A-Za-z][A-Za-z ,.'?!-]{2,90}\)/g;
// a speaker label in front of a line: "Speaker 1 (female, Malayalam):", "Female voice:", "Male 2:"
const ROLE_LABEL = /^\s*(?:[-*•]\s+)?(?:Speaker \d+|(?:Fe)?male(?: voice| speaker)?(?: \d)?)\s*(?:\([^)]*\))?\s*:\s*["“]?/i;
const GLUED_TAIL = /(?<=[^\s"“(\[])["”')\]](?=[A-Z][a-z]+[ ,.])/g; // …ketto"Okay. And we will…  -> the words start at Okay (a closing mark touching a word, never an opening one)

export function stripNotes(text) {
  const out = [];
  let dropped = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (NOTE_LINE.some((re) => re.test(raw))) {
      dropped = true;
      let at = -1;
      for (const m of raw.matchAll(GLUED_TAIL)) at = m.index + 1;
      if (at >= 0) out.push(raw.slice(at));
      continue;
    }
    out.push(balanceQuotes(raw.replace(ROLE_LABEL, '').replace(/^\s*"([^"]*)"\s*$/, '$1'))); // a whole line wrapped in quotes loses them; so does a quote left without its partner
  }
  const text2 = out.join(' ')
    .replace(/\bWe have speech segments[^.]*\.\s*/gi, '') // the same notes in the middle of a line
    .replace(/\bAnaly[sz]e the audio\s*:\s*/gi, '')
    .replace(/\b(?:Speaker \d+|(?:Fe)?male voice)\s*(?:\([^)]*\))?\s*:\s*["“]?/gi, '')
    .replace(GLOSS, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: balanceQuotes(text2), dropped: dropped || text2 !== out.join(' ').replace(/\s{2,}/g, ' ').trim() };
}

// A run of offsets written straight onto the words ("0:11uh So, 0:13the first step 0:18selection", they come from the video the
// audio was cut from) is removed. A time in speech is followed by a space or a punctuation mark ("at 4:50 sir", "9:00, 10:00,
// 11:00, 12:00" read out from an agenda), so those stay, and so does anything with fewer than four such offsets.
export function stripStamps(text) {
  const t = String(text || '');
  const glued = /(?<![\d:])\d{1,2}:\d{2}(?=[^\s\d:.,;!?)\]\-–/])/g;
  if ((t.match(glued) || []).length < 4) return t;
  return t.replace(/(?<![\d:])\d{1,2}:\d{2}(?=[^\s\d:.,;!?)\]\-–/])|^[ \t]*\d{1,2}:\d{2}(?![\d:])[ \t]*/gm, '').replace(/\s{2,}/g, ' ').trim();
}

// Remembers what was said in the last stretch of the meeting, so a passage the model wrote again in the next piece is dropped.
// The model also writes the same passage twice with other fillers and punctuation ("Okay, suppose VAPT part is not there" /
// "Okay. Suppose VAPT part is not uh there."), so a sentence of six words or more that shares 85% of its words with a
// recent one goes too.
// Words that change what is said, however short: a number, a negation. Two sentences that differ in one of them are two sentences.
const MATTERS = new Set('zero one two three four five six seven eight nine ten first second third fourth fifth no not never none nothing without cannot dont didnt wont isnt cant hundred lakh crore thousand million half'.split(' '));
const minor = (w) => w.length <= 4 && !/\d/.test(w) && !MATTERS.has(w); // uh, um, the, and, ma, am ... never a date, a name or a number
const wordSet = (k) => new Set(k.split(' ').filter(Boolean));
const alike = (a, b) => {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  if (both / (a.size + b.size - both) < 0.85) return false;
  for (const w of a) if (!b.has(w) && !minor(w)) return false;
  for (const w of b) if (!a.has(w) && !minor(w)) return false;
  return true;
};
export function makeDeduper(keep = 60) {
  const recent = []; // { k, w }, oldest first
  return (text) => {
    const out = [];
    for (const p of String(text || '').split(/(?<=[.!?।])\s+/)) {
      const k = norm(p);
      if (k.length < 30) {
        out.push(p);
        continue;
      }
      const w = wordSet(k);
      if (recent.some((r) => r.k === k || (w.size >= 6 && r.w.size >= 6 && alike(w, r.w)))) continue;
      recent.push({ k, w });
      if (recent.length > keep) recent.shift();
      out.push(p);
    }
    return out.join(' ').trim();
  };
}

// Everything above, in order. `names`: people we know (to strip the labels the model made up). `dedupe`: a makeDeduper().
export function cleanTranscript(text, names = [], dedupe = null) {
  const notes = stripNotes(text); // line-level notes first: their time ranges would otherwise look like the start of thinking
  const { text: t, leaked } = stripThinking(notes.text);
  let clean = dropRepeats(stripStamps(t));
  if (dedupe) clean = dedupe(clean);
  clean = stripLabels(clean, names);
  return { text: clean, leaked: leaked || notes.dropped, changed: clean !== String(text || '').trim() };
}

// ---- the script a passage is written in -----------------------------------------------------------------------
// The dedicated transcription model sometimes writes English words in Malayalam or Hindi letters ("ദിസ് ഫ്യൂ സ്റ്റെപ്പ്സ്" for
// "this few steps"). In a meeting that mixes English in, a long passage with no Latin letters at all is a sign of that.
const LETTER = /\p{L}/u;
export function latinShare(text) {
  let latin = 0;
  let all = 0;
  for (const ch of String(text || '')) {
    if (!LETTER.test(ch)) continue;
    all++;
    if (/[A-Za-z]/.test(ch)) latin++;
  }
  return all ? latin / all : 0;
}
export const letterCount = (text) => [...String(text || '')].filter((ch) => LETTER.test(ch)).length;
export const looksTransliterated = (text) => letterCount(text) >= 400 && latinShare(text) < 0.03;

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
