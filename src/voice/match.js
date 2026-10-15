// Who is speaking: compare voice fingerprints (256-number vectors) to the people enrolled, with an
// "unknown" answer when unsure, smoothing over neighbouring pieces of speech, and the alignment of the
// transcript text to those pieces. Pure functions: no browser APIs, so every rule here is unit-tested.
//
// Honest limits: this is a best guess. It needs clean speech of 1.5 seconds or more per piece, struggles
// when people talk over each other (those pieces become "unknown" on purpose), and the thresholds were
// set from a small amount of real speech. See docs/SETUP.md.

export const THRESHOLDS = {
  accept: 0.42, // a person must score at least this against the piece of speech
  margin: 0.07, // and beat the runner-up by this much, or the piece is "unknown"
  strong: 0.6, // at or above this a label is kept even if its neighbours disagree
  mixedShare: 0.6, // a sentence needs this share of its speech time from one voice to be labelled
  gap: 2.5, // seconds: neighbours further apart than this do not vote for each other
};

export function cosine(a, b) {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / (Math.sqrt(na * nb) || 1);
}

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function mean(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return normalize(out);
}

// ---- compact storage: one signed byte per number, as base64 ----
export function pack(emb) {
  const bytes = new Int8Array(emb.length);
  for (let i = 0; i < emb.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(emb[i] * 127)));
  let bin = '';
  for (const b of new Uint8Array(bytes.buffer)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function unpack(b64) {
  const bin = atob(b64);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = ((bin.charCodeAt(i) << 24) >> 24) / 127;
  return normalize(out);
}

// A person: { id, name, centroid: b64, windows: [b64...] }. Unpacked copies are cached on the object.
function prepared(person) {
  if (!person._c) {
    person._c = unpack(person.centroid);
    person._w = (person.windows || []).map(unpack);
  }
  return person;
}

// How well one fingerprint matches a person: the average voice plus the closest single sample, so a person
// who sounds different between a calm and an animated stretch is still recognised.
export function personScore(emb, person) {
  const p = prepared(person);
  const c = cosine(emb, p._c);
  const best = p._w.length ? Math.max(...p._w.map((w) => cosine(emb, w))) : c;
  return 0.6 * c + 0.4 * best;
}

export function classify(emb, people, th = THRESHOLDS) {
  if (!emb || !people?.length) return { id: null, name: null, score: 0, margin: 0, why: 'no voices enrolled' };
  const scored = people.map((p) => ({ id: p.id, name: p.name, score: personScore(emb, p) })).sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  const margin = top.score - (second?.score ?? 0);
  if (top.score < th.accept) return { id: null, name: null, score: top.score, margin, best: top.name, why: 'too different from everyone enrolled' };
  // Two voices at once land between two people: close scores and nobody strong means overlap or noise.
  if (second && margin < th.margin && top.score < th.strong + 0.1) return { id: null, name: null, score: top.score, margin, best: top.name, why: 'could be two people (or both talking)' };
  return { id: top.id, name: top.name, score: top.score, margin };
}

// segs: [{ t0, t1, e: b64 }] in time order. Returns the same pieces with { id, name, score, raw } added.
export function labelSegments(segs, people, th = THRESHOLDS) {
  const raw = segs.map((s) => classify(unpack(s.e), people, th));
  return segs.map((s, i) => {
    const r = raw[i];
    const near = (j) => (j >= 0 && j < segs.length && Math.abs((j < i ? s.t0 - segs[j].t1 : segs[j].t0 - s.t1)) <= th.gap ? raw[j] : null);
    const prev = near(i - 1);
    const next = near(i + 1);
    let { id, name } = r;
    if (id && r.score < th.strong && prev?.id && prev.id === next?.id && prev.id !== id) {
      // one weak piece between two pieces of someone else: that is a glitch, not a new speaker
      ({ id, name } = prev);
    } else if (!id && prev?.id && prev.id === next?.id && r.score >= th.accept * 0.85 && r.best === prev.name) {
      // a piece just under the line, surrounded by the same person on both sides
      ({ id, name } = prev);
    }
    return { ...s, id, name, score: r.score, why: r.why };
  });
}

// ---- text to speech time ----
export function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?।])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// One transcribed passage { t, dur, text } and the labelled pieces of speech that fall inside it. The
// sentences are spread over the passage's speech time in proportion to their length (the transcript has
// no word times), and each sentence takes the voice that talks for most of its share. Returns
// [{ t, text, id, name, mixed }].
export function alignPassage(passage, labelled, th = THRESHOLDS) {
  const end = passage.t + passage.dur;
  const inside = labelled.filter((s) => s.t1 > passage.t - 0.3 && s.t0 < end + 0.3);
  const sens = sentences(passage.text);
  if (!sens.length) return [];
  const speech = inside.reduce((a, s) => a + (s.t1 - s.t0), 0);
  if (!inside.length || speech < 1) return sens.map((text) => ({ t: passage.t, text, id: null, name: null, mixed: false, none: true }));
  const weights = sens.map((x) => Math.max(1, x.length));
  const total = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let from = 0;
  for (const [i, text] of sens.entries()) {
    const to = from + (weights[i] / total) * speech;
    // walk the pieces, adding up how much of [from, to] each voice owns
    const share = new Map();
    let at = 0;
    let startT = null;
    for (const s of inside) {
      const len = s.t1 - s.t0;
      const a = Math.max(from, at);
      const b = Math.min(to, at + len);
      if (b > a) {
        const key = s.id || 'unknown';
        share.set(key, (share.get(key) || 0) + (b - a));
        if (startT == null) startT = s.t0 + (a - at);
      }
      at += len;
    }
    let bestId = null;
    let best = 0;
    for (const [k, v] of share) if (v > best) [bestId, best] = [k, v];
    const covered = [...share.values()].reduce((a, b) => a + b, 0) || 1;
    const dominant = best / covered >= th.mixedShare;
    const person = bestId && bestId !== 'unknown' && dominant ? inside.find((s) => s.id === bestId) : null;
    out.push({ t: startT ?? passage.t, text, id: person ? person.id : null, name: person ? person.name : null, mixed: !dominant });
    from = to;
  }
  return out;
}

const first = (s) => String(s || '').toLowerCase().normalize('NFKC').trim().split(/\s+/)[0];

// Merges the voice label with Meet's live-caption speaker for the same moment. If they agree the name stays
// as is; if they disagree both are shown, never hidden; if only one knows, that one is used.
export function mergeWithCaptions(lines, captions, { slack = 4 } = {}) {
  if (!captions?.length) return lines.map((l) => ({ ...l, source: l.name ? 'voice' : null }));
  return lines.map((l) => {
    const end = l.t + Math.max(3, Math.min(30, l.text.length / 14));
    const hit = captions.filter((c) => c.t <= end + slack && (c.t2 ?? c.t) + slack >= l.t);
    const tally = new Map();
    for (const c of hit) tally.set(c.name, (tally.get(c.name) || 0) + 1);
    const cap = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    if (l.name && cap) {
      return first(cap) === first(l.name) ? { ...l, source: 'voice+captions' } : { ...l, source: 'conflict', captionName: cap };
    }
    if (!l.name && cap) return { ...l, name: cap, source: 'captions' };
    return { ...l, source: l.name ? 'voice' : null };
  });
}

// Final text label for a line, e.g. "Amal Raj", "Amal Raj (captions say Priya)" or "Unknown speaker".
export function labelText(l, { unknown = 'Unknown speaker' } = {}) {
  if (!l.name) return unknown;
  if (l.source === 'conflict') return `${l.name} (captions say ${l.captionName})`;
  return l.name;
}

// The whole thing: the transcript of one meeting as labelled lines [{ t, label, name, text, source }].
// Only passages from the meeting's remote audio (src "others") are labelled; "me" is the note-taker's mic.
export function labelTranscript(meeting, people, { captions, th = THRESHOLDS, myName = '', room = false } = {}) {
  const all = [...(meeting.voiceSegs || [])].sort((a, b) => a.t0 - b.t0);
  if (!all.length || !people?.length) return null;
  // Pieces of speech come from two streams: the meeting tab (the others) and, in room mode, the microphone (s: 'm').
  const tab = labelSegments(all.filter((s) => s.s !== 'm'), people, th);
  const mic = room ? labelSegments(all.filter((s) => s.s === 'm'), people, th) : [];
  const passages = (meeting.segments || []).filter((s) => (s.src === 'others' || (room && s.src === 'me')) && s.dur);
  if (!passages.length) return null;
  const lines = [];
  for (const p of passages.sort((a, b) => a.t - b.t)) {
    const src = p.src;
    // Meet's captions describe the people on the call, not the room, so they are only merged into the tab's lines.
    const merged = mergeWithCaptions(alignPassage({ t: p.t, dur: p.dur, text: p.text }, src === 'me' ? mic : tab, th), src === 'me' ? [] : captions);
    for (const m of merged) {
      const prev = lines.at(-1);
      const label = labelText(m);
      if (prev && prev.label === label && prev.src === src && m.t - prev.t < 40) prev.text += ` ${m.text}`;
      else lines.push({ t: m.t, label, name: m.name, text: m.text, source: m.source, src, mixed: m.mixed });
    }
  }
  if (!room) for (const s of meeting.segments || []) if (s.src === 'me') lines.push({ t: s.t, label: myName || 'Me', name: myName || null, text: s.text, source: 'mic', src: 'me' });
  return lines.sort((a, b) => a.t - b.t);
}

// People without enrolment: group the pieces of one meeting into voices (average-linkage on cosine).
// Used to name voices from a meeting and to check how many distinct voices a recording holds.
export function clusterVoices(segs, { threshold = 0.55 } = {}) {
  const vecs = segs.map((s) => unpack(s.e));
  let clusters = vecs.map((_, i) => ({ members: [i] }));
  const sim = (a, b) => {
    let s = 0;
    for (const i of a.members) for (const j of b.members) s += cosine(vecs[i], vecs[j]);
    return s / (a.members.length * b.members.length);
  };
  for (;;) {
    let best = -1;
    let pair = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = sim(clusters[i], clusters[j]);
        if (s > best) [best, pair] = [s, [i, j]];
      }
    }
    if (!pair || best < 1 - threshold) break;
    const [i, j] = pair;
    clusters[i] = { members: [...clusters[i].members, ...clusters[j].members] };
    clusters.splice(j, 1);
  }
  return clusters
    .map((c) => ({ members: c.members.sort((a, b) => a - b), seconds: c.members.reduce((a, i) => a + (segs[i].t1 - segs[i].t0), 0), centroid: pack(mean(c.members.map((i) => vecs[i]))) }))
    .sort((a, b) => b.seconds - a.seconds);
}

// People heard speaking, as { name: [firstSeenSec, lastSeenSec, count] }: the same shape as the participant
// list, so attendance can treat "heard in the meeting" as evidence of presence.
export function voicePresence(lines) {
  const out = {};
  for (const l of lines || []) {
    if (!l.name || l.source === 'mic') continue;
    const end = l.t + Math.max(3, Math.min(30, l.text.length / 14));
    const p = out[l.name];
    if (p) {
      p[1] = Math.max(p[1], end);
      p[2]++;
    } else out[l.name] = [l.t, end, 1];
  }
  return out;
}
