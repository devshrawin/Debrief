// Runs the speaker model off the main thread. Messages in: { type: 'init', model, wasmPaths } then
// { id, pcm } for each piece of speech. Messages out: { ready } / { id, emb } (emb is null for pieces
// that are too short). Nothing here touches the network except loading the model file it is told to.
import { createEmbedder } from './embedder.js';

let embedder = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      embedder = await createEmbedder({ model: m.model, wasmPaths: m.wasmPaths });
      self.postMessage({ ready: true });
      return;
    }
    const emb = embedder ? await embedder.embed(m.pcm) : null;
    self.postMessage({ id: m.id, emb }, emb ? [emb.buffer] : []);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
