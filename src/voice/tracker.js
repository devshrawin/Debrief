// Finds the pieces of speech in the live audio of the meeting (1.5 to 4 seconds each) and hands them on to be
// fingerprinted. It works on the same 128 ms blocks the recorder already produces, with a simple loudness
// test that adapts to the room, and costs almost nothing. It only ever holds a few seconds of audio.
export const SR = 16000;
const MIN_SEC = 1.5;
const MAX_SEC = 4;
const PAUSE_BLOCKS = 3; // 3 x 128 ms of quiet ends a piece of speech

export class VoiceTracker {
  // onSegment({ t0, t1, pcm }) is called for each piece. t0 and t1 are seconds since the recording began.
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.floor = -60; // running estimate of the room's quiet level, in dB
    this.samples = 0; // samples seen so far: the recording clock
    this.cur = []; // blocks of the piece being collected
    this.curStart = 0;
    this.quiet = 0;
    this.speechBlocks = 0;
  }

  push(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const db = 10 * Math.log10(sum / block.length + 1e-12);
    // The floor follows quiet stretches down quickly and creeps up slowly, so speech never raises it much.
    this.floor = db < this.floor ? db : db < this.floor + 6 ? this.floor * 0.98 + db * 0.02 : this.floor;
    const speech = db > Math.max(this.floor + 9, -52);
    const at = this.samples;
    this.samples += block.length;
    if (speech) {
      if (!this.cur.length) this.curStart = at;
      this.cur.push(block);
      this.speechBlocks++;
      this.quiet = 0;
    } else if (this.cur.length) {
      this.quiet++;
      this.cur.push(block);
      if (this.quiet >= PAUSE_BLOCKS) this.close(true);
    }
    if (this.cur.length && (this.samples - this.curStart) / SR >= MAX_SEC) this.close(false);
  }

  close(trimQuiet) {
    const blocks = trimQuiet ? this.cur.slice(0, this.cur.length - this.quiet) : this.cur;
    const speech = this.speechBlocks;
    this.cur = [];
    this.quiet = 0;
    this.speechBlocks = 0;
    const len = blocks.reduce((a, b) => a + b.length, 0);
    // Pieces that are mostly gaps are not one person's speech: skip them rather than guess.
    if (len / SR < MIN_SEC || (speech * (blocks[0]?.length || 2048)) / len < 0.6) return;
    const pcm = new Float32Array(len);
    let o = 0;
    for (const b of blocks) {
      pcm.set(b, o);
      o += b.length;
    }
    this.onSegment({ t0: this.curStart / SR, t1: this.curStart / SR + len / SR, pcm });
  }

  flush() {
    if (this.cur.length) this.close(true);
  }
}
