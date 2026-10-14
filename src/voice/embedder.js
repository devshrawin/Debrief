// Turns a 1.5-4 s piece of speech into a 256-number voice fingerprint, locally, with the WeSpeaker ResNet34
// speaker model run by ONNX Runtime Web (WebAssembly). Used inside a worker so it never blocks recording.
import * as ort from 'onnxruntime-web/wasm';
import { fbank } from './fbank.js';

export const DIM = 256;
export const MIN_SAMPLES = 16000 * 1; // shorter than a second carries too little voice

// opts: { model: ArrayBuffer | Uint8Array | string (url), wasmPaths: string (folder of the ort wasm files) }
export async function createEmbedder(opts) {
  ort.env.wasm.numThreads = 1; // no cross-origin isolation in an extension, so no threads
  ort.env.wasm.proxy = false;
  if (opts.wasmPaths) ort.env.wasm.wasmPaths = opts.wasmPaths;
  const model = typeof opts.model === 'string' ? new Uint8Array(await (await fetch(opts.model)).arrayBuffer()) : opts.model;
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return {
    // pcm: Float32Array, 16 kHz mono. Returns a unit-length Float32Array(256), or null if there is too little audio.
    async embed(pcm) {
      if (pcm.length < MIN_SAMPLES) return null;
      const { data, frames } = fbank(pcm);
      if (frames < 50) return null;
      const out = await session.run({ feats: new ort.Tensor('float32', data, [1, frames, 80]) });
      const e = Float32Array.from(out.embs.data);
      let n = 0;
      for (const v of e) n += v * v;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < e.length; i++) e[i] /= n;
      return e;
    },
    release: () => session.release?.(),
  };
}
