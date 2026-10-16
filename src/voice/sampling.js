// After a meeting: turn the waiting pieces of audio into one short clip per unnamed voice, then delete them all.
import { classify, unpack } from './match.js';
import { getPiece, pieceKey, fromInt16, makeClip, putSample, hasSample, deletePieces } from './samples.js';

// meeting === null only clears the waiting audio.
export async function saveSamples(meetingId, meeting, people) {
  try {
    if (!meeting) return;
    const todo = [];
    for (const p of people) if (p.auto && !(await hasSample(p.id))) todo.push(p); // named voices too: the clip stays so it can be played in Settings
    if (!todo.length) return;
    // which waiting piece belongs to which voice, best matches first
    const best = new Map(todo.map((p) => [p.id, []]));
    for (const s of meeting.voiceSegs || []) {
      const r = classify(unpack(s.e), people);
      if (r.id && best.has(r.id)) best.get(r.id).push({ s, score: r.score });
    }
    for (const p of todo) {
      const ranked = best.get(p.id).sort((a, b) => b.score - a.score).slice(0, 6);
      const pcms = [];
      for (const { s } of ranked) {
        const i16 = await getPiece(pieceKey(meetingId, s.t0, s.s));
        if (i16) pcms.push(fromInt16(i16));
        if (pcms.length >= 3) break;
      }
      if (pcms.length) await putSample(p.id, makeClip(pcms));
    }
  } finally {
    await deletePieces(meetingId).catch(() => {});
  }
}
