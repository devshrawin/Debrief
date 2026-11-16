// Talks to the voice worker. Keeps a short queue: on a slow computer old pieces are dropped, never the recorder.
import { resolveModel, NOT_INSTALLED } from './modelstore.js';

// With no modelDownloadUrl this reads modelUrl exactly as before. With one, the model may come from the bundle, the cache or a download.
export function createVoiceClient({ workerUrl, modelUrl, wasmPaths, modelDownloadUrl, modelSha256, onModelProgress, maxQueue = 24 }) {
  const worker = new Worker(workerUrl);
  const pending = new Map();
  let nextId = 1;
  let ready;
  let readyFail;
  const readyP = new Promise((res, rej) => {
    ready = res;
    readyFail = rej;
  });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.ready) return ready();
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.emb);
  };
  worker.onerror = (e) => readyFail(new Error(e.message || 'voice worker failed'));
  (async () => {
    try {
      let bytes;
      if (modelDownloadUrl) {
        const r = await resolveModel({ bundledUrl: modelUrl, downloadUrl: modelDownloadUrl, expectedSha256: modelSha256, onProgress: onModelProgress });
        bytes = r.bytes || new Uint8Array(await (await fetch(r.url)).arrayBuffer());
      } else {
        const res = await fetch(modelUrl);
        if (res.ok === false) throw new Error(NOT_INSTALLED); // lite build with no address set
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      worker.postMessage({ type: 'init', model: bytes, wasmPaths }, [bytes.buffer]);
    } catch (e) {
      readyFail(e);
    }
  })();
  return {
    ready: readyP,
    get backlog() {
      return pending.size;
    },
    // Resolves with a unit-length Float32Array(256), null (too short / dropped), or rejects.
    embed(pcm) {
      if (pending.size >= maxQueue) return Promise.resolve(null);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, pcm }, [pcm.buffer]);
      });
    },
    async drain(ms = 20000) {
      const end = Date.now() + ms;
      while (pending.size && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    },
    close() {
      worker.terminate();
      for (const p of pending.values()) p.resolve(null);
      pending.clear();
    },
  };
}
