// Gets the speaker model (an ONNX file) from the extension itself, from Cache Storage, or, only when the user has set an
// address, from the network. The default is the full build: the model is bundled and nothing is ever downloaded.
//
// Policy note: an ONNX model is data, not code, and the WebAssembly runtime (extension/vendor/ort) always stays bundled.
// Even so, Chrome Web Store rules on downloading resources and how a review treats a "lite" build cannot be checked from here.
// The download path is off unless the user types an address in Settings.

export const MODEL_SHA256 = '7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068'; // extension/models/wespeaker_resnet34_lm.onnx
export const MODEL_BYTES = 26530309;
export const CACHE_NAME = 'debrief-voice-model-v1';
export const NOT_INSTALLED = 'The speaker model is not installed. Add its address in Settings → Voices, or install the full version of Debrief.';
const MIN_BYTES = 5 * 1048576;
const MAX_BYTES = 80 * 1048576;

const httpsUrl = (u) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

async function bundledHere(url, fetch) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    if (r.ok) return true;
  } catch {}
  try {
    const r = await fetch(url, { headers: { range: 'bytes=0-0' } }); // some file servers refuse HEAD
    return !!r.ok;
  } catch {
    return false;
  }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// An ONNX file is a protobuf: it starts with a field tag byte (0x08 ir_version, or 0x12/0x1a/0x22...), never "<" of an HTML page.
function looksLikeOnnx(bytes) {
  return bytes.length > 16 && bytes[0] !== 0x3c && bytes[0] !== 0x7b && (bytes[0] & 0x07) <= 2 && (bytes[0] >> 3) >= 1;
}

async function download(url, { expectedSha256, onProgress, fetch }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The speaker model download failed (HTTP ${res.status}).`);
  if (/text\/html/i.test(res.headers?.get?.('content-type') || '')) throw new Error('That address returned a web page, not the speaker model.');
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (total && (total < MIN_BYTES || total > MAX_BYTES)) throw new Error('That file is not the right size for the speaker model.');
  const parts = [];
  let received = 0;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      if (received > MAX_BYTES) {
        reader.cancel?.();
        throw new Error('That file is not the right size for the speaker model.');
      }
      onProgress?.(received, total);
    }
  } else {
    const b = new Uint8Array(await res.arrayBuffer());
    parts.push(b);
    received = b.length;
    onProgress?.(received, total || received);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  if (received < MIN_BYTES || received > MAX_BYTES) throw new Error('That file is not the right size for the speaker model.');
  if (!looksLikeOnnx(bytes)) throw new Error('That file does not look like a speaker model.');
  if (expectedSha256) {
    const got = hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    if (got !== String(expectedSha256).toLowerCase()) throw new Error('The downloaded speaker model does not match its checksum, so it was not used.');
  }
  return bytes;
}

// Returns { url, source: 'bundled' } or { bytes, source: 'cache' | 'download' }.
export async function resolveModel({ bundledUrl, downloadUrl, expectedSha256, onProgress, fetch = globalThis.fetch, caches = globalThis.caches } = {}) {
  if (await bundledHere(bundledUrl, fetch)) return { url: bundledUrl, source: 'bundled' };
  const wantDownload = typeof downloadUrl === 'string' && downloadUrl.trim() !== '';
  if (wantDownload) {
    try {
      const hit = await (await caches?.open(CACHE_NAME))?.match(downloadUrl);
      if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), source: 'cache' };
    } catch {}
  }
  if (wantDownload) {
    if (!httpsUrl(downloadUrl.trim())) throw new Error('The speaker model address must start with https://.');
    const bytes = await download(downloadUrl.trim(), { expectedSha256, onProgress, fetch });
    try {
      await (await caches?.open(CACHE_NAME))?.put(downloadUrl, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch {} // not being able to keep it only means a download next time
    return { bytes, source: 'download' };
  }
  throw new Error(NOT_INSTALLED);
}

export async function removeModel({ caches = globalThis.caches } = {}) {
  try {
    return await caches.delete(CACHE_NAME);
  } catch {
    return false;
  }
}

export async function modelStatus({ bundledUrl, downloadUrl, fetch = globalThis.fetch, caches = globalThis.caches } = {}) {
  const out = { bundled: await bundledHere(bundledUrl, fetch), cached: false };
  try {
    const c = await caches.open(CACHE_NAME);
    const hit = downloadUrl ? await c.match(downloadUrl) : (await c.matchAll?.())?.[0];
    if (hit) {
      out.cached = true;
      out.bytes = (await hit.arrayBuffer()).byteLength;
    }
  } catch {}
  return out;
}
