// Optional short audio samples of voices (learned, named or recorded), so you can play one in Settings and recognise who it is.
// On by default (Settings -> Voices switches it off). While recording, short pieces of speech wait in this browser's IndexedDB; after the meeting
// one clip of a few seconds is kept per learned voice and every waiting piece is deleted. A clip is deleted when
// the voice is deleted, merged or forgotten. Nothing here is ever uploaded.
import { encodeWav } from '../wav.js';

const DB = 'debrief-voice';
const SR = 16000;
export const MAX_PIECES = 200; // waiting pieces kept per meeting
export const CLIP_SEC = 8;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('pieces');
      r.result.createObjectStore('samples');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      // a request's result is undefined for a key that is not there: that must come back as undefined, not as the request itself
      t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const toInt16 = (f32) => Int16Array.from(f32, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))));
export const fromInt16 = (i16) => Float32Array.from(i16, (x) => x / 32768);

// origin 'm' = the microphone (room mode), anything else = the meeting tab
export const pieceKey = (meetingId, t0, origin) => `${meetingId}|${origin === 'm' ? 'm' : ''}${Math.round(t0 * 100)}`;

export const putPiece = (key, i16) => tx('pieces', 'readwrite', (s) => s.put(i16, key));
export const getPiece = (key) => tx('pieces', 'readonly', (s) => s.get(key));

export async function deletePieces(meetingId) {
  await tx('pieces', 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${meetingId}|`, `${meetingId}|￿`)));
}

export const putSample = (personId, blob) => tx('samples', 'readwrite', (s) => s.put(blob, personId));
export const getSample = (personId) => tx('samples', 'readonly', (s) => s.get(personId));
export const hasSample = async (personId) => (await tx('samples', 'readonly', (s) => s.count(personId))) > 0;
export const deleteSample = (personId) => tx('samples', 'readwrite', (s) => s.delete(personId));

export async function clearAllAudio() {
  await tx('pieces', 'readwrite', (s) => s.clear());
  await tx('samples', 'readwrite', (s) => s.clear());
}

// Joins up to CLIP_SEC seconds of the given pieces (best first) into one WAV clip.
export function makeClip(pieces) {
  const gap = new Float32Array(Math.round(SR * 0.3));
  const parts = [];
  let len = 0;
  for (const p of pieces) {
    if (len + p.length > CLIP_SEC * SR && parts.length) break;
    parts.push(p, gap);
    len += p.length + gap.length;
  }
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return encodeWav(out.subarray(0, Math.min(len, CLIP_SEC * SR)), SR);
}
