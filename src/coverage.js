// Did the speech-to-text answer cover what was said? A model sometimes answers a 2-4 minute piece with a few sentences, or
// with nothing, and nothing in the answer says so: the minutes then miss that stretch without anyone knowing. This module
//   1. judges a piece: the text for the amount of speech in the audio (judgePiece),
//   2. re-reads a doubtful piece in short parts, which models handle far better than one long piece (readInParts),
//   3. lists the stretches of a finished transcript that have no text at all (findGaps), and says them in words.
import { SR, rms, VOICED_RMS } from './chunker.js';

export { VOICED_RMS };

export const MIN_JUDGED_SEC = 20; // less speech than this is not judged: a few words are a few words
export const FLOOR_CHARS_PER_SEC = 3; // real speech in the languages we handle runs at 8-15 characters per voiced second
export const GAP_CHARS_PER_SEC = 1.5; // still below this after a re-read: the stretch is reported as a gap
const MAX_FRUITLESS = 2; // re-reads that found nothing more, after which a recording stops trying (each costs a few requests)

const letters = (t) => String(t || '').replace(/\s+/g, '').length;

// Seconds of speech in a list of PCM blocks.
export function voicedSeconds(blocks, sr = SR) {
  let n = 0;
  for (const b of blocks) if (b.length && rms(b) >= VOICED_RMS) n += b.length;
  return n / sr;
}

// { ok, short, gap, expected }: `short` = worth a second look, `gap` = too little even to pass as a short answer.
export function judgePiece(text, voicedSec) {
  const chars = letters(text);
  if (!(voicedSec >= MIN_JUDGED_SEC)) return { ok: true, short: false, gap: false, expected: 0, chars };
  const short = chars < voicedSec * FLOOR_CHARS_PER_SEC;
  return { ok: !short, short, gap: chars < voicedSec * GAP_CHARS_PER_SEC, expected: Math.round(voicedSec * FLOOR_CHARS_PER_SEC), chars };
}

// Where to cut a piece into parts of about `partSec`: at the quietest 128 ms near each boundary, so no word is cut.
export function splitRanges(pcm, partSec = 45, sr = SR) {
  const n = pcm.length;
  const parts = Math.max(1, Math.round(n / (partSec * sr)));
  if (parts === 1) return [[0, n]];
  const win = Math.round(0.128 * sr);
  const cuts = [0];
  for (let i = 1; i < parts; i++) {
    const ideal = Math.round((n * i) / parts);
    const lo = Math.max(cuts[cuts.length - 1] + 5 * sr, ideal - 4 * sr);
    const hi = Math.min(n - 5 * sr, ideal + 4 * sr);
    let best = ideal;
    let bestRms = Infinity;
    for (let p = lo; p + win <= hi; p += win) {
      const r = rms(pcm.subarray(p, p + win));
      if (r < bestRms) {
        bestRms = r;
        best = p + (win >> 1);
      }
    }
    cuts.push(best);
  }
  cuts.push(n);
  return cuts.slice(0, -1).map((a, i) => [a, cuts[i + 1]]);
}

const loudest = (pcm, win = 2048) => {
  let m = 0;
  for (let p = 0; p < pcm.length; p += win) m = Math.max(m, rms(pcm.subarray(p, Math.min(pcm.length, p + win))));
  return m;
};

// Transcribes the piece again as several shorter ones and joins the answers. `encode(pcm)` makes the WAV, `transcribeFn(wav)`
// asks the speech model. Silent parts are not sent. Returns { text, parts } (parts = how many requests were made).
export async function readInParts({ pcm, encode, transcribeFn, partSec = 45, sr = SR }) {
  const out = [];
  let parts = 0;
  for (const [a, b] of splitRanges(pcm, partSec, sr)) {
    const sub = pcm.subarray(a, b);
    if (sub.length < sr || loudest(sub) < 0.012) continue;
    parts++;
    const t = String((await transcribeFn(encode(sub))) || '').trim();
    if (t) out.push(t);
  }
  return { text: out.join(' '), parts };
}

// Can a piece be cut into at least two parts? (A 25 s piece cannot be read in shorter parts than it is.)
export const canSplit = (pcm, partSec = 45, sr = SR) => splitRanges(pcm, partSec, sr).length > 1;

// One piece, start to finish: transcribe it, and when the answer is too thin for the speech in it read it again as short parts
// (at most `budget.left` times a recording, as each costs a few requests). The longer of the two answers is kept, and `gap`
// says the piece is still far too thin. A failing re-read never loses the first answer.
export async function transcribePiece({ pcm, wav, voicedSec, transcribeFn, encode, budget = { left: 8 }, note = () => {} }) {
  let text = String((await transcribeFn(wav)) || '');
  let verdict = judgePiece(text, voicedSec);
  if (verdict.short && budget.left > 0 && canSplit(pcm)) {
    budget.left--;
    note(`${verdict.chars} characters for ${Math.round(voicedSec)} s of speech looks incomplete (at least ${verdict.expected} expected), reading it again in parts`);
    const again = await readInParts({ pcm, encode, transcribeFn }).catch((e) => (note(`reading in parts failed (${e.message})`), { text: '', parts: 0 }));
    note(`${again.parts} part(s) -> ${again.text.length} characters`);
    if (again.text.length > text.length) text = again.text;
    else if ((budget.fruitless = (budget.fruitless || 0) + 1) >= MAX_FRUITLESS) budget.left = 0; // music or noise, or a model that cannot do better: stop spending requests on it
    verdict = judgePiece(text, voicedSec);
  }
  return { text, gap: verdict.gap, chars: verdict.chars };
}

// ---- a finished transcript ---------------------------------------------------------------------------
const RATE = 9; // characters per second to say a text: a little under real speech, so a doubtful stretch is never over-reported

// Stretches [{ from, to }] (seconds) longer than `minGap` where nothing was transcribed. A piece of text covers the time it
// was cut from (`c` and `dur` on the segment, written since this check exists), or else the time the text takes to say.
// `excused` are stretches that are known not to be speech: pauses the person made on purpose, and silent pieces.
export function findGaps(segments, excused = [], { minGap = 75, rate = RATE } = {}) {
  const segs = (segments || []).filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const skip = (excused || []).filter((p) => p && Number.isFinite(p.from)).map((p) => ({ from: p.from, to: p.to ?? Infinity })).sort((a, b) => a.from - b.from);
  const out = [];
  let covered = -Infinity; // how far the text so far reaches
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    covered = Math.max(covered, Number.isFinite(a.c) && Number.isFinite(a.dur) ? a.c + a.dur : a.t + Math.max(2, String(a.text || '').length / rate));
    const next = segs[i + 1];
    if (!next || next.t - covered < minGap) continue;
    let from = covered;
    const parts = [];
    for (const p of skip) {
      if (p.to <= from) continue;
      if (p.from >= next.t) break;
      if (p.from > from) parts.push([from, p.from]);
      from = Math.max(from, p.to);
      if (from >= next.t) break;
    }
    if (from < next.t) parts.push([from, next.t]);
    for (const [x, y] of parts) if (y - x >= minGap) out.push({ from: Math.round(x), to: Math.round(y) });
  }
  return out;
}

// Gaps found while recording ({ t, dur }) and gaps found in the transcript, as one list without overlaps.
export function mergeGaps(recorded = [], found = []) {
  const all = [...recorded.filter((g) => g && Number.isFinite(g.t)).map((g) => ({ from: Math.round(g.t), to: Math.round(g.t + (g.dur || 0)) })), ...found]
    .filter((g) => g.to > g.from)
    .sort((a, b) => a.from - b.from);
  const out = [];
  for (const g of all) {
    const last = out[out.length - 1];
    if (last && g.from <= last.to + 5) last.to = Math.max(last.to, g.to);
    else out.push({ ...g });
  }
  return out;
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const gapLabel = (g) => `${mmss(g.from)}–${mmss(g.to)}`;
export const gapMinutes = (gaps) => Math.max(1, Math.round(gaps.reduce((a, g) => a + (g.to - g.from), 0) / 60));
