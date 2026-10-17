// One request per chunk for Gemini: the microphone and the tab audio are mixed into ONE stream, and who spoke is worked out
// afterwards from how loud each side was (a 128 ms level for the tab and for the mic, kept next to the audio).
import { rms } from './chunker.js';

export const BLOCK_SEC = 2048 / 16000; // the worklet delivers 2048-sample blocks at 16 kHz
const QUIET = 0.006;
const MIC_WINS = 1.5; // the mic counts as the speaker when it is this much louder than the tab

// Pairs up tab and mic blocks (they come from two taps of one audio clock) and hands on their sum plus both levels.
export class Mixer {
  constructor(onBlock, maxLag = 25) {
    this.onBlock = onBlock;
    this.tab = [];
    this.mic = [];
    this.maxLag = maxLag; // a side that stalls must not hold the other one back for ever
  }

  pushTab(b) {
    this.tab.push(b);
    this.pump();
  }

  pushMic(b) {
    this.mic.push(b);
    this.pump();
  }

  pump() {
    while ((this.tab.length && this.mic.length) || this.tab.length > this.maxLag || this.mic.length > this.maxLag) this.emit(this.tab.shift(), this.mic.shift());
  }

  emit(t, m) {
    const n = (t || m).length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, (t ? t[i] : 0) + (m ? m[i] : 0)));
    this.onBlock(out, { tab: t ? rms(t) : 0, mic: m ? rms(m) : 0 });
  }

  drain() {
    while (this.tab.length || this.mic.length) this.emit(this.tab.shift(), this.mic.shift());
  }
}

// Level meter with the Chunker's reading API, for the streams that no longer have a chunker of their own.
export class Meter {
  constructor() {
    this.total = 0;
    this.maxEver = 0;
    this.levelPeak = 0;
  }

  push(b) {
    this.total += b.length;
    const r = rms(b);
    this.maxEver = Math.max(this.maxEver, r);
    this.levelPeak = Math.max(this.levelPeak, r);
  }

  takeLevel() {
    const p = this.levelPeak;
    this.levelPeak = 0;
    return p;
  }

  flush() {}
}

export const timelineOf = (metas) => ({ tab: metas.map((m) => Math.round(m.tab * 1e4) / 1e4), mic: metas.map((m) => Math.round(m.mic * 1e4) / 1e4) });

// Splits a transcript into sentences, and works out for each one who spoke it. The text has no times, so each sentence
// gets a stretch of the chunk's SPEAKING time in proportion to its length; it is "me" when the mic was louder than the
// tab for at least half of that stretch. Neighbouring sentences with the same speaker are joined.
export function attributeMixed(text, startSec, tl) {
  const sentences = String(text || '').split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return [];
  const n = Math.min(tl?.tab?.length || 0, tl?.mic?.length || 0);
  if (!n) return [{ t: startSec, src: 'others', text: sentences.join(' ') }];
  let active = [];
  for (let i = 0; i < n; i++) if (Math.max(tl.tab[i], tl.mic[i]) > QUIET) active.push(i);
  if (!active.length) active = Array.from({ length: n }, (_, i) => i);
  const total = sentences.reduce((a, s) => a + s.length, 0);
  const out = [];
  let used = 0;
  let from = 0;
  sentences.forEach((s, k) => {
    used += s.length;
    const to = k === sentences.length - 1 ? active.length : Math.max(from + 1, Math.round((used / total) * active.length));
    const span = active.slice(Math.min(from, active.length - 1), Math.max(to, from + 1));
    from = to;
    const mine = span.filter((i) => tl.mic[i] > QUIET && tl.mic[i] > tl.tab[i] * MIC_WINS).length;
    const src = mine >= span.length / 2 ? 'me' : 'others';
    const last = out[out.length - 1];
    if (last && last.src === src) last.text += ` ${s}`;
    else out.push({ t: Math.round((startSec + span[0] * BLOCK_SEC) * 10) / 10, src, text: s });
  });
  return out;
}
