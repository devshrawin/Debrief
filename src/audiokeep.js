// Optional: keep the meeting's audio on THIS computer (Settings -> keepAudio) so a line can be played back
// and a stretch re-transcribed later. PRIVACY: this feature never uploads anything. The recording is
// compressed in the offscreen document, written to this browser's IndexedDB and only read by Debrief's own
// pages on this computer. (Re-transcription is a separate, explicit action that sends audio to the speech
// provider the user already chose; that path is not here.)
//
// Seeking inside one long MediaRecorder WebM is unreliable (no cues), so the recording is stored as
// INDEPENDENT segments of about 30 s: the recorder is restarted every 30 s and every blob is a complete,
// playable file. Size: Opus at 24 kbit/s is about 11 MB per hour of speech.
//
// IndexedDB: database 'debrief-audio', store 'seg', key [meetingId, seq],
// fields { meetingId, seq, t0 (s since recording start), dur (s), blob, savedAt }.

const DB = 'debrief-audio';
const STORE = 'seg';
export const SEG_MS = 30000;
export const BITRATE = 24000;
const MIME = 'audio/webm;codecs=opus';
const DAY = 86400000;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore(STORE, { keyPath: ['meetingId', 'seq'] });
      s.createIndex('meetingId', 'meetingId');
      s.createIndex('savedAt', 'savedAt');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('write aborted'));
    });
  } finally {
    db.close();
  }
}

const byMeeting = (meetingId) => (s) => s.index('meetingId').getAll(meetingId);

export const putSeg = (seg) => run('readwrite', (s) => s.put({ savedAt: Date.now(), ...seg }));

// metadata only: no blobs (a caller that lists a long meeting must not hold hours of audio)
export async function listSegs(meetingId) {
  const all = await run('readonly', byMeeting(meetingId));
  return all.map(({ blob, ...m }) => ({ ...m, bytes: blob?.size || 0 })).sort((a, b) => a.seq - b.seq);
}

// the segment that contains this second (the last one that started at or before it, if it also reaches it)
export async function segAt(meetingId, tSec) {
  const all = (await run('readonly', byMeeting(meetingId))).sort((a, b) => a.seq - b.seq);
  let hit = null;
  for (const s of all) if (s.t0 <= tSec && tSec < s.t0 + s.dur + 0.5) hit = s;
  return hit ? { seq: hit.seq, t0: hit.t0, dur: hit.dur, blob: hit.blob } : null;
}

// the blobs (in order) that cover fromSec..toSec; each carries its own t0 so the caller can trim
export async function segRange(meetingId, fromSec, toSec) {
  const all = (await run('readonly', byMeeting(meetingId))).sort((a, b) => a.seq - b.seq);
  return all.filter((s) => s.t0 < toSec && s.t0 + s.dur > fromSec).map((s) => ({ seq: s.seq, t0: s.t0, dur: s.dur, blob: s.blob }));
}

export async function keptInfo(meetingId) {
  const segs = await listSegs(meetingId);
  return { segs: segs.length, seconds: Math.round(segs.reduce((a, s) => a + s.dur, 0)), bytes: segs.reduce((a, s) => a + s.bytes, 0) };
}

export async function deleteAudio(meetingId) {
  await run('readwrite', (s) => s.delete(IDBKeyRange.bound([meetingId, -Infinity], [meetingId, Infinity])));
}

// Deletes segments saved more than `days` days ago. 0 (or nothing) = keep until the meeting is deleted.
export async function purgeOld(days, now = Date.now()) {
  const d = Number(days);
  if (!(d > 0)) return 0;
  const cutoff = now - d * DAY;
  let n = 0;
  await run('readwrite', (s) => {
    const r = s.index('savedAt').openCursor(IDBKeyRange.upperBound(cutoff, true));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return;
      c.delete();
      n++;
      c.continue();
    };
  });
  return n;
}

export async function totalKept() {
  const all = await run('readonly', (s) => s.getAll());
  return { meetings: new Set(all.map((x) => x.meetingId)).size, bytes: all.reduce((a, x) => a + (x.blob?.size || 0), 0) };
}

// ---- recording ---------------------------------------------------------------------------------------

// Records `stream` (the mixed tab + mic stream) as independent segments. Never throws into the caller:
// a failed write stops keeping and calls onError once; transcription is not involved at all.
// Pausing stops the recorder, so nothing at all is kept from a paused stretch (and the caller also silences the gains).
export async function startKeeping({ stream, meetingId, segMs = SEG_MS, Recorder = globalThis.MediaRecorder, put = putSeg, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, onError = () => {} }) {
  const startMs = now();
  let seq = 0;
  try {
    const have = await listSegs(meetingId);
    if (have.length) seq = have[have.length - 1].seq + 1; // never overwrite an earlier take of the same meeting
  } catch {}
  const mimeType = Recorder.isTypeSupported?.(MIME) === false ? undefined : MIME;
  let cur = null;
  let paused = false;
  let failed = false;
  let queue = Promise.resolve();

  const save = (seg) => {
    queue = queue.then(async () => {
      if (failed) return;
      try {
        await put(seg);
      } catch (e) {
        failed = true;
        clearTimer(timer);
        end(cur);
        cur = null;
        onError(e);
      }
    });
    return queue;
  };

  // the end time is taken when the stop is asked for: the recorder reports it a moment later
  const end = (c) => {
    if (!c) return;
    c.t1 = now();
    try {
      c.rec.stop();
    } catch {}
  };

  const begin = () => {
    const rec = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BITRATE });
    const c = { rec, chunks: [], t0: now(), done: null };
    c.done = new Promise((resolve) => {
      rec.ondataavailable = (e) => e.data?.size && c.chunks.push(e.data);
      rec.onstop = () => {
        const dur = Math.round((((c.t1 ?? now()) - c.t0) / 1000) * 10) / 10;
        if (c.chunks.length && dur > 0 && !failed) {
          const blob = new Blob(c.chunks, { type: 'audio/webm' });
          resolve(save({ meetingId, seq: seq++, t0: Math.round(((c.t0 - startMs) / 1000) * 10) / 10, dur, blob }));
        } else resolve();
      };
      rec.onerror = () => resolve();
    });
    rec.start();
    return c;
  };

  // The new recorder starts before the old one stops, so a seam can overlap a moment but never loses speech.
  const rotate = () => {
    if (failed || paused) return;
    const old = cur;
    cur = begin();
    end(old);
  };

  cur = begin();
  const timer = setTimer(rotate, segMs);

  return {
    rotate,
    setPaused(on) {
      on = !!on;
      if (on === paused || failed) return;
      paused = on;
      if (on) {
        end(cur);
        cur = null;
      } else cur = begin();
    },
    // ends the recording and waits until the last segment is written (at most a few seconds)
    async stop() {
      clearTimer(timer);
      const last = cur;
      cur = null;
      end(last);
      let t;
      await Promise.race([Promise.all([last?.done, queue]), new Promise((r) => (t = setTimeout(r, 4000)))]);
      clearTimeout(t);
    },
    get failed() {
      return failed;
    },
  };
}

// ---- decoding for re-transcription -------------------------------------------------------------------

// Blobs (as from segRange) -> one Float32Array, 16 kHz mono, ready for the speech-to-text pipeline.
// Returns null where the audio APIs are missing (node tests) or the audio cannot be decoded.
export async function pcm16kFrom(blobs, { AudioContextCtor = globalThis.AudioContext, OfflineCtor = globalThis.OfflineAudioContext } = {}) {
  if (!AudioContextCtor || !OfflineCtor || !blobs?.length) return null;
  const SR = 16000;
  const ctx = new AudioContextCtor();
  const parts = [];
  try {
    for (const b of blobs) {
      const buf = await ctx.decodeAudioData(await (b.blob || b).arrayBuffer());
      const off = new OfflineCtor(1, Math.max(1, Math.ceil(buf.duration * SR)), SR); // a mono context mixes the channels down
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start();
      parts.push((await off.startRendering()).getChannelData(0));
    }
  } catch {
    return null;
  } finally {
    ctx.close?.().catch?.(() => {});
  }
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
