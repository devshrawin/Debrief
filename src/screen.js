// Screen notes: watches the tab's picture (video at about 1 frame/s) and, only when the shared screen changed and then
// held still, hands one small JPEG to onFrame, which asks the vision model to describe it (see vision.js).
// The pure parts (signature, distance, ScreenGate) work on plain pixel arrays so they run in node without a canvas.
//
// COST, for the settings text: every described frame is ONE extra model request on the minutes provider.
// A one-hour meeting with a slide change every 2 minutes is about 60 / 2 = 30 requests (plus a few for frames
// that turn out to be just people on camera). The hard ceiling is MAX_FRAMES = 120 per recording.

export const CHANGE_MIN = 12; // of 256 bits: how different from the last described picture counts as "changed"
export const STABLE_MAX = 4; // of 256: two samples this close are "the same picture, held still"
export const BIG_CHANGE = 64; // leaves the back-off
export const MAX_FRAMES = 120; // described frames per recording
export const NONE_LIMIT = 3; // NONE answers in a row (presenter unknown) before backing off
export const BACKOFF_SEC = 300;
const SIDE = 16;

// RGBA (w*h*4) -> 16x16 greys by block averaging. A canvas that is already 16x16 passes straight through.
export function grey16(rgba, w, h) {
  const out = new Float32Array(SIDE * SIDE);
  const cnt = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(SIDE - 1, Math.floor((y * SIDE) / h));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const k = gy * SIDE + Math.min(SIDE - 1, Math.floor((x * SIDE) / w));
      out[k] += g;
      cnt[k]++;
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = cnt[k] ? out[k] / cnt[k] : 0;
  return out;
}

// 256 bits (one byte each here): brighter than the picture's mean or not.
export function signature(rgba, w, h) {
  const g = grey16(rgba, w, h);
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  return Uint8Array.from(g, (v) => (v > mean ? 1 : 0));
}

export function distance(a, b) {
  if (!a || !b) return SIDE * SIDE;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Decides, sample by sample, whether a frame is worth describing. No timers, no canvas.
export class ScreenGate {
  constructor({ maxFrames = MAX_FRAMES, changeMin = CHANGE_MIN, stableMax = STABLE_MAX } = {}) {
    Object.assign(this, { maxFrames, changeMin, stableMax });
    this.prev = null; // the sample before this one
    this.described = null; // signature of the last frame sent for description
    this.frames = 0;
    this.lastEmit = -Infinity;
    this.noneRun = 0;
    this.presenting = null; // true / false / null = never told
  }

  setPresenting(on) {
    const v = on == null ? null : !!on;
    if (v === true && this.presenting !== true) {
      this.described = null; // a new share: the first steady picture is described again
      this.noneRun = 0;
    }
    this.presenting = v;
  }

  get backoff() {
    return this.presenting == null && this.noneRun >= NONE_LIMIT;
  }

  // -> { emit, big } ; changes nothing but the "previous sample" (commit() records an actual emission)
  sample(sig, nowSec, { paused = false } = {}) {
    const prev = this.prev;
    this.prev = paused ? null : sig; // after a pause two fresh samples are needed
    if (paused || this.presenting === false || this.frames >= this.maxFrames) return { emit: false };
    if (!prev || distance(prev, sig) > this.stableMax) return { emit: false }; // moving: a transition or a scroll
    const d = distance(this.described, sig);
    if (d < this.changeMin) return { emit: false };
    if (this.backoff) {
      const big = d >= BIG_CHANGE;
      if (!big && nowSec - this.lastEmit < BACKOFF_SEC) return { emit: false };
      return { emit: true, big };
    }
    return { emit: true, big: false };
  }

  commit(sig, nowSec, { big = false } = {}) {
    this.described = sig;
    this.frames++;
    this.lastEmit = nowSec;
    if (big) this.noneRun = 0; // a big change ends the back-off
  }

  // the model's verdict on an emitted frame; NONE only counts while nobody has said whether anyone presents
  result(none) {
    if (!none) this.noneRun = 0;
    else if (this.presenting == null) this.noneRun++;
  }
}

// Draws the video, samples it every everySec seconds, emits a JPEG when the gate says so.
// onFrame(blob, tSec) may return a promise of the note text ('' for NONE), which feeds the back-off.
export class ScreenWatcher {
  constructor({ video, everySec = 30, onFrame, now = Date.now, budgetOk = async () => true, makeCanvas, setTimer = setInterval, clearTimer = clearInterval, gate = new ScreenGate() }) {
    Object.assign(this, { video, onFrame, now, budgetOk, setTimer, clearTimer, gate });
    this.everySec = Math.max(5, Number(everySec) || 30);
    this.makeCanvas = makeCanvas || defaultCanvas;
    this.paused = false;
    this.busy = false;
    this.startedAt = now();
    this.timer = null;
  }

  start() {
    this.startedAt = this.now();
    this.timer = this.setTimer(() => this.tick(), this.everySec * 1000);
  }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  setPaused(on) {
    this.paused = !!on;
  }

  setPresenting(on) {
    this.gate.setPresenting(on);
  }

  async tick() {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    try {
      const w = this.video?.videoWidth;
      const h = this.video?.videoHeight;
      if (!w || !h) return false;
      const big = this.canvas || (this.canvas = this.makeCanvas(Math.min(1024, w), Math.round((Math.min(1024, w) * h) / w)));
      const small = this.small || (this.small = this.makeCanvas(SIDE, SIDE));
      big.ctx.drawImage(this.video, 0, 0, big.width, big.height);
      small.ctx.drawImage(big.canvas, 0, 0, SIDE, SIDE);
      const sig = signature(small.ctx.getImageData(0, 0, SIDE, SIDE).data, SIDE, SIDE);
      const nowSec = (this.now() - this.startedAt) / 1000;
      const d = this.gate.sample(sig, nowSec, { paused: this.paused });
      if (!d.emit) return false;
      if (!(await this.budgetOk())) return false; // nothing is recorded, so the same picture is tried again next tick
      if (this.stopped) return false;
      const blob = await big.toBlob('image/jpeg', 0.6);
      if (!blob) return false;
      this.gate.commit(sig, nowSec, d);
      const text = await this.onFrame(blob, Math.round(nowSec));
      if (typeof text === 'string') this.gate.result(text === '');
      return true;
    } catch {
      return false; // a failed describe must never reach the recording
    } finally {
      this.busy = false;
    }
  }
}

// Browser canvas (offscreen documents have a DOM); sized once, a 2D context kept with it.
function defaultCanvas(width, height) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const toBlob = (type, quality) => (canvas.convertToBlob ? canvas.convertToBlob({ type, quality }) : new Promise((r) => canvas.toBlob(r, type, quality)));
  return { canvas, ctx, width, height, toBlob };
}
