// Cuts a stream of 16 kHz PCM blocks into chunks, preferring to cut at pauses.

export const SR = 16000;
const PAUSE = 0.35 * SR; // this much quiet counts as a pause
const QUIET_RMS = 0.006;
const SPEECH_RMS = 0.012; // chunk is skipped unless some 128 ms block is louder than this

const rms = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
};

export class Chunker {
  // Looks for a pause once a chunk reaches minSec; always cuts at maxSec.
  constructor(src, onChunk, { minSec = 18, maxSec = 28, onSkip } = {}) {
    this.onSkip = onSkip;
    this.levelPeak = 0;
    this.total = 0; // samples ever received
    this.maxEver = 0;
    this.src = src;
    this.minLen = minSec * SR;
    this.maxLen = maxSec * SR;
    this.onChunk = onChunk;
    this.blocks = [];
    this.len = 0;
    this.offset = 0; // samples since recording start at the current chunk's start
    this.quiet = 0;
    this.loudest = 0;
  }

  push(block) {
    this.total += block.length;
    this.blocks.push(block);
    this.len += block.length;
    const r = rms(block);
    this.loudest = Math.max(this.loudest, r);
    this.levelPeak = Math.max(this.levelPeak, r);
    this.maxEver = Math.max(this.maxEver, r);
    this.quiet = r < QUIET_RMS ? this.quiet + block.length : 0;
    if ((this.len >= this.minLen && this.quiet >= PAUSE) || this.len >= this.maxLen) this.flush();
  }

  // Loudest block since the last call; drives the popup's live level meter.
  takeLevel() {
    const p = this.levelPeak;
    this.levelPeak = 0;
    return p;
  }

  flush() {
    if (!this.len) return;
    const pcm = new Float32Array(this.len);
    let o = 0;
    for (const b of this.blocks) {
      pcm.set(b, o);
      o += b.length;
    }
    const start = this.offset / SR;
    const loud = this.loudest;
    this.offset += this.len;
    this.blocks = [];
    this.len = 0;
    this.quiet = 0;
    this.loudest = 0;
    if (pcm.length < SR || loud < SPEECH_RMS) {
      // too short or silent
      if (pcm.length >= SR) this.onSkip?.(this.src, start, loud);
      return;
    }
    this.onChunk(this.src, start, pcm);
  }
}

