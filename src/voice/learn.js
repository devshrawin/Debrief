// Learning voices from meetings on its own (opt-in). Meet's live captions say who is speaking; when a piece of
// speech sits inside exactly one person's caption, with nobody else's caption nearby, it is evidence for that
// name. Evidence from several meetings builds a fingerprint. Nothing here is certain, so:
//  - a learned voice is not used for naming anyone until it has enough clean speech from enough meetings (LEARN.readySecs, LEARN.readyMeetings),
//  - two different names whose voices come out nearly identical are both dropped (captions or room mix-up),
//  - pieces unlike the rest of the person's evidence are thrown out,
//  - voices you recorded yourself are never changed by this.
import { cosine, mean, pack, unpack, classify, clusterVoices } from './match.js';
import { isIconText } from '../iconText.js';

export const LEARN = {
  lead: 2, // seconds a caption may lag behind the speech (the speech started this much before it showed)
  tail: 1,
  clear: 1.5, // seconds around a piece in which no other speaker's caption may appear
  minPieces: 6, // evidence needed from one meeting before it counts
  minSecs: 15,
  readySecs: 45, // total clean speech before a learned voice is used
  readyMeetings: 2, // and it must have been seen in this many different meetings
  outlier: 0.35, // pieces below this similarity to the person's own average are dropped
  twin: 0.8, // two names this similar are ambiguous
  keep: 12, // individual fingerprints kept
};

const norm = (n) => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isMe = (n, myName) => /^you$/i.test(String(n).trim()) || (myName && norm(n) === norm(myName));

// Which pieces of this meeting can be tied to exactly one caption name. Returns Map name -> [{ t0, t1, e }].
export function evidence(meeting, { myName = '' } = {}) {
  const caps = (meeting.captions || []).filter((c) => c.name && !isIconText(c.name) && !isMe(c.name, myName));
  const all = (meeting.captions || []).filter((c) => c.name && !isIconText(c.name));
  const out = new Map();
  for (const s of meeting.voiceSegs || []) {
    const mine = caps.filter((c) => c.t - LEARN.lead <= s.t0 && (c.t2 ?? c.t) + LEARN.tail >= s.t1);
    if (new Set(mine.map((c) => norm(c.name))).size !== 1) continue; // none, or two different people
    const who = norm(mine[0].name);
    // nobody else (including the note-taker) captioned anywhere near this piece
    const crowded = all.some((c) => norm(c.name) !== who && c.t - LEARN.lead - LEARN.clear <= s.t1 && (c.t2 ?? c.t) + LEARN.tail + LEARN.clear >= s.t0);
    if (crowded) continue;
    if (!out.has(who)) out.set(who, { name: mine[0].name, segs: [] });
    out.get(who).segs.push(s);
  }
  return out;
}

function cleaned(segs) {
  let vecs = segs.map((s) => ({ s, v: unpack(s.e) }));
  for (let pass = 0; pass < 2 && vecs.length >= LEARN.minPieces; pass++) {
    const c = mean(vecs.map((x) => x.v));
    const kept = vecs.filter((x) => cosine(x.v, c) >= LEARN.outlier);
    if (kept.length === vecs.length) break;
    vecs = kept;
  }
  return vecs;
}

// Updates the list of enrolled people from one meeting. Returns { list, changed, report }.
export function learnFromMeeting(meeting, people, { myName = '' } = {}) {
  const report = { meeting: meeting.id, learned: [], skipped: [] };
  if (!meeting?.voiceSegs?.length || !meeting?.captions?.length) {
    report.skipped.push({ why: !meeting?.captions?.length ? 'no captions were read in this meeting' : 'no voice pieces were recorded' });
    return { list: people, changed: false, report };
  }
  const ev = evidence(meeting, { myName });
  const found = [];
  for (const [key, { name, segs }] of ev) {
    const vecs = cleaned(segs);
    const secs = vecs.reduce((a, x) => a + (x.s.t1 - x.s.t0), 0);
    if (vecs.length < LEARN.minPieces || secs < LEARN.minSecs) {
      report.skipped.push({ name, why: `only ${vecs.length} clean pieces (${secs.toFixed(0)} s)` });
      continue;
    }
    found.push({ key, name, vecs, secs, centroid: mean(vecs.map((x) => x.v)) });
  }
  // two names with the same voice in one meeting: cannot tell which is right
  const bad = new Set();
  for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) if (cosine(found[i].centroid, found[j].centroid) >= LEARN.twin) (bad.add(i), bad.add(j));
  let list = [...people];
  found.forEach((f, i) => {
    if (bad.has(i)) {
      report.skipped.push({ name: f.name, why: 'another speaker in this meeting sounded the same, so it was unclear who was who' });
      return;
    }
    const idx = list.findIndex((p) => norm(p.name) === f.key);
    const existing = idx >= 0 ? list[idx] : null;
    if (existing && !existing.auto) {
      report.skipped.push({ name: f.name, why: 'you recorded this voice yourself, so it is left as it is' });
      return;
    }
    // does this evidence belong to somebody else we already know (a different name's voice)? then it is a mix-up
    const rival = list.find((p) => p !== existing && (!p.auto || p.ready) && cosine(unpack(p.centroid), f.centroid) >= LEARN.twin && norm(p.name) !== f.key);
    if (rival) {
      report.skipped.push({ name: f.name, why: `sounds the same as ${rival.name}, so it was not learned` });
      return;
    }
    if (existing?.learnedFrom?.includes(meeting.id)) return;
    const step = Math.max(1, Math.floor(f.vecs.length / LEARN.keep));
    const fresh = f.vecs.filter((_, k) => k % step === 0).map((x) => pack(x.v)).slice(0, LEARN.keep);
    let rec;
    if (existing) {
      const w = existing.secs || 1;
      const c = mean([scale(unpack(existing.centroid), w), scale(f.centroid, f.secs)]); // weighted by seconds of speech
      rec = { ...existing, centroid: pack(c), windows: [...(existing.windows || []), ...fresh].slice(-LEARN.keep * 2), secs: Math.round(w + f.secs), meetings: (existing.meetings || 1) + 1, learnedFrom: [...(existing.learnedFrom || []), meeting.id].slice(-50), updated: Date.now() };
    } else {
      rec = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: f.name, lang: 'free', langs: ['free'], centroid: pack(f.centroid), windows: fresh, secs: Math.round(f.secs), meetings: 1, auto: true, learnedFrom: [meeting.id], created: Date.now() };
    }
    rec.ready = rec.secs >= LEARN.readySecs && rec.meetings >= LEARN.readyMeetings; // two meetings: one mislabelled stretch cannot make a voice trusted
    if (existing) list[idx] = rec;
    else list = [...list, rec];
    report.learned.push({ name: f.name, secs: Math.round(f.secs), total: rec.secs, ready: rec.ready, isNew: !existing });
  });
  return { list, changed: report.learned.length > 0, report };
}

const scale = (v, k) => Float32Array.from(v, (x) => x * k);

// The people whose voices may be used to name speakers: recorded by hand, or learned enough.
export const usableVoices = (people) => (people || []).filter((p) => !p.auto || p.ready);

// Voices in a meeting that match nobody enrolled, grouped, for "name this voice". At most `max` groups of
// at least `minSecs` seconds. Large meetings are sampled so grouping stays quick.
export function unnamedGroups(meeting, people, { max = 4, minSecs = 15, cap = 300 } = {}) {
  const usable = usableVoices(people);
  const segs = (meeting.voiceSegs || []).filter((s) => !usable.length || !classify(unpack(s.e), usable).id);
  if (segs.length < 4) return [];
  const step = Math.max(1, Math.ceil(segs.length / cap));
  const sample = segs.filter((_, i) => i % step === 0);
  return clusterVoices(sample)
    .filter((g) => g.seconds * step >= minSecs)
    .slice(0, max)
    .map((g) => ({ seconds: Math.round(g.seconds * step), pieces: g.members.length, centroid: g.centroid, windows: g.members.filter((_, k) => k % Math.max(1, Math.floor(g.members.length / 8)) === 0).slice(0, 8).map((i) => sample[i].e), at: g.members.slice(0, 3).map((i) => Math.round(sample[i].t0)) }));
}
