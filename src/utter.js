// Turns the timed utterances a speech provider returned for one piece into transcript segments with real times.
import { BLOCK_SEC, sideOver } from './mixer.js';

const MERGE_GAP = 1.2; // seconds of silence under which two utterances of one speaker are one line
const MAX_SEC = 45;
const MAX_CHARS = 700;
const r1 = (x) => Math.round(x * 10) / 10;

// utterances: [{ t0, t1, text, spk? }] in seconds from the piece start. { t } is where the piece starts in the recording,
// { src } the piece's own side, { timeline } (mixed mic + tab stream only) decides me/others per utterance from the
// levels inside its own time window. `spk` is a speaker index that holds only within this piece (the provider numbers
// voices afresh for every request), so it is a hint for merging, never a name. `u: 1` marks times that were measured.
export function segmentsFromUtterances(utterances, { t = 0, src = 'others', timeline = null } = {}) {
  const out = [];
  let prev = null; // { src, spk, start, end } of the last utterance, as the segment it went into
  let lastSide = src === 'mix' ? 'others' : src;
  for (const u of utterances || []) {
    const text = String(u?.text || '').trim();
    if (!text) continue;
    let side = src;
    if (timeline) {
      const i0 = Math.floor(u.t0 / BLOCK_SEC);
      side = sideOver(timeline, i0, Math.max(i0 + 1, Math.ceil(u.t1 / BLOCK_SEC))) || lastSide; // nothing voiced there: as the one before
      lastSide = side;
    }
    const spk = Number.isInteger(u.spk) ? u.spk : undefined;
    const last = out[out.length - 1];
    if (last && prev.src === side && prev.spk === spk && u.t0 - prev.end < MERGE_GAP && u.t1 - prev.start <= MAX_SEC && last.text.length + 1 + text.length <= MAX_CHARS) {
      last.text += ` ${text}`;
      prev.end = Math.max(prev.end, u.t1);
      continue;
    }
    out.push({ t: r1(t + u.t0), src: side, text, ...(spk === undefined ? {} : { spk }), u: 1 });
    prev = { src: side, spk, start: u.t0, end: u.t1 };
  }
  return out;
}
