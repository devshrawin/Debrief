// Kaldi-style log-mel filterbank features, the input the WeSpeaker speaker model was trained on:
// 25 ms hamming frames every 10 ms, pre-emphasis 0.97, 80 mel bins from 20 Hz, log, mean-normalised.
// (This is what torchaudio.compliance.kaldi.fbank does with WeSpeaker's settings.)

export const SR = 16000;
const FRAME = 400;
const HOP = 160;
const NFFT = 512;
const BINS = 80;

const HAMMING = new Float64Array(FRAME);
for (let i = 0; i < FRAME; i++) HAMMING[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

// Triangular mel filters, Kaldi layout (bins 0..255; the Nyquist bin carries no weight).
const BANKS = (() => {
  const mel = (f) => 1127 * Math.log(1 + f / 700);
  const low = mel(20);
  const high = mel(SR / 2);
  const delta = (high - low) / (BINS + 1);
  const nfb = NFFT / 2;
  const bw = SR / NFFT;
  const banks = [];
  for (let b = 0; b < BINS; b++) {
    const l = low + b * delta;
    const c = low + (b + 1) * delta;
    const r = low + (b + 2) * delta;
    const w = new Float64Array(nfb);
    for (let i = 0; i < nfb; i++) {
      const m = mel(bw * i);
      if (m > l && m < r) w[i] = m <= c ? (m - l) / (c - l) : (r - m) / (r - c);
    }
    banks.push(w);
  }
  return banks;
})();

// Iterative radix-2 FFT of a real frame; returns power spectrum for bins 0..NFFT/2-1.
const COS = new Float64Array(NFFT / 2);
const SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / NFFT);
  SIN[i] = -Math.sin((2 * Math.PI * i) / NFFT);
}
const REV = (() => {
  const bits = Math.log2(NFFT);
  const r = new Uint16Array(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    r[i] = y;
  }
  return r;
})();

function powerSpectrum(frame, re, im, out) {
  for (let i = 0; i < NFFT; i++) {
    re[REV[i]] = frame[i];
    im[REV[i]] = 0;
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k;
        const b = a + half;
        const xr = re[b] * COS[t] - im[b] * SIN[t];
        const xi = re[b] * SIN[t] + im[b] * COS[t];
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  for (let i = 0; i < NFFT / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
}

// pcm: Float32Array in [-1, 1] at 16 kHz. Returns { data: Float32Array(frames * 80), frames }.
export function fbank(pcm) {
  const frames = pcm.length >= FRAME ? 1 + Math.floor((pcm.length - FRAME) / HOP) : 0;
  const data = new Float32Array(frames * BINS);
  const frame = new Float64Array(NFFT);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const power = new Float64Array(NFFT / 2);
  const x = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    let mean = 0;
    for (let i = 0; i < FRAME; i++) {
      x[i] = pcm[f * HOP + i] * 32768;
      mean += x[i];
    }
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) x[i] -= mean;
    frame.fill(0);
    for (let i = FRAME - 1; i >= 0; i--) frame[i] = (x[i] - 0.97 * (i > 0 ? x[i - 1] : x[0])) * HAMMING[i];
    powerSpectrum(frame, re, im, power);
    for (let b = 0; b < BINS; b++) {
      let e = 0;
      const w = BANKS[b];
      for (let i = 0; i < NFFT / 2; i++) e += power[i] * w[i];
      data[f * BINS + b] = Math.log(Math.max(e, 1.1920929e-7));
    }
  }
  // mean normalisation over the segment
  for (let b = 0; b < BINS; b++) {
    let m = 0;
    for (let f = 0; f < frames; f++) m += data[f * BINS + b];
    m /= Math.max(1, frames);
    for (let f = 0; f < frames; f++) data[f * BINS + b] -= m;
  }
  return { data, frames };
}
