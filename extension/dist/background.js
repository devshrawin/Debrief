(() => {
  // src/iconText.js
  var isIconText = (s) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(s || "").trim());
  var MENU = /^(?:(?:un)?pin|spotlight|remove|mute|unmute|reframe|zoom (?:in|out)|minimi[sz]e|maximi[sz]e|full screen|more actions|add (?:a )?(?:person|people)|keep|send a message)\b.*$/i;
  var UI_PHRASE = /(?:\bcan['\u2019]?t\b|\bcannot\b|\bremotely\b|\bsomeone else\b|\bthis participant\b|^you (?:are|have|will|can)\b|^turn (?:on|off)\b|^(?:backgrounds?|effects?|captions?|activities|host controls|meeting details|participants|people|in the call|contributors|visual effects|apply visual effects|more options|raise hand|lower hand|present now|share screen|leave call|end call|chat|reactions?)(?:\s+(?:and|&)\s+\w+)?$)/i;
  var isMenuText = (s) => {
    const t = String(s || "").trim();
    if (UI_PHRASE.test(t) || t.split(/\s+/).length > 6) return true;
    return /\b(?:to|from) your main screen\b/i.test(t) || /^(?:reframe|zoom in|zoom out|keep|pin|unpin)$/i.test(t) || /^(?:un)?pin\s/i.test(t) || MENU.test(t) && /\b(?:screen|presentation|participant|tile|view)\b/i.test(t);
  };

  // src/voice/match.js
  var THRESHOLDS = {
    accept: 0.42,
    // a person must score at least this against the piece of speech
    margin: 0.07,
    // and beat the runner-up by this much, or the piece is "unknown"
    strong: 0.6,
    // at or above this a label is kept even if its neighbours disagree
    mixedShare: 0.6,
    // a sentence needs this share of its speech time from one voice to be labelled
    gap: 2.5
    // seconds: neighbours further apart than this do not vote for each other
  };
  function cosine(a, b) {
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
  function normalize(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return Float32Array.from(v, (x) => x / n);
  }
  function mean(vectors) {
    const out = new Float32Array(vectors[0].length);
    for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
    return normalize(out);
  }
  function pack(emb) {
    const bytes = new Int8Array(emb.length);
    for (let i = 0; i < emb.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(emb[i] * 127)));
    let bin = "";
    for (const b of new Uint8Array(bytes.buffer)) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function unpack(b64) {
    const bin = atob(b64);
    const out = new Float32Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24 >> 24) / 127;
    return normalize(out);
  }
  function prepared(person) {
    if (!person._c) {
      person._c = unpack(person.centroid);
      person._w = (person.windows || []).map(unpack);
    }
    return person;
  }
  function personScore(emb, person) {
    const p = prepared(person);
    const c = cosine(emb, p._c);
    const best = p._w.length ? Math.max(...p._w.map((w) => cosine(emb, w))) : c;
    return 0.6 * c + 0.4 * best;
  }
  function classify(emb, people, th = THRESHOLDS) {
    if (!emb || !people?.length) return { id: null, name: null, score: 0, margin: 0, why: "no voices enrolled" };
    const scored = people.map((p) => ({ id: p.id, name: p.name, score: personScore(emb, p) })).sort((a, b) => b.score - a.score);
    const [top, second] = scored;
    const margin = top.score - (second?.score ?? 0);
    if (top.score < th.accept) return { id: null, name: null, score: top.score, margin, best: top.name, why: "too different from everyone enrolled" };
    if (second && margin < th.margin && top.score < th.strong + 0.1) return { id: null, name: null, score: top.score, margin, best: top.name, why: "could be two people (or both talking)" };
    return { id: top.id, name: top.name, score: top.score, margin };
  }
  function clusterVoices(segs, { threshold = 0.55 } = {}) {
    const vecs = segs.map((s) => unpack(s.e));
    let clusters = vecs.map((_, i) => ({ members: [i] }));
    const sim = (a, b) => {
      let s = 0;
      for (const i of a.members) for (const j of b.members) s += cosine(vecs[i], vecs[j]);
      return s / (a.members.length * b.members.length);
    };
    for (; ; ) {
      let best = -1;
      let pair = null;
      for (let i2 = 0; i2 < clusters.length; i2++) {
        for (let j2 = i2 + 1; j2 < clusters.length; j2++) {
          const s = sim(clusters[i2], clusters[j2]);
          if (s > best) [best, pair] = [s, [i2, j2]];
        }
      }
      if (!pair || best < 1 - threshold) break;
      const [i, j] = pair;
      clusters[i] = { members: [...clusters[i].members, ...clusters[j].members] };
      clusters.splice(j, 1);
    }
    return clusters.map((c) => ({ members: c.members.sort((a, b) => a - b), seconds: c.members.reduce((a, i) => a + (segs[i].t1 - segs[i].t0), 0), centroid: pack(mean(c.members.map((i) => vecs[i]))) })).sort((a, b) => b.seconds - a.seconds);
  }

  // src/voice/learn.js
  var LEARN = {
    lead: 2,
    // seconds a caption may lag behind the speech (the speech started this much before it showed)
    tail: 1,
    clear: 1.5,
    // seconds around a piece in which no other speaker's caption may appear
    minPieces: 6,
    // evidence needed from one meeting before it counts
    minSecs: 15,
    readySecs: 45,
    // total clean speech before a learned voice is used
    readyMeetings: 2,
    // and it must have been seen in this many different meetings
    outlier: 0.35,
    // pieces below this similarity to the person's own average are dropped
    twin: 0.8,
    // two names this similar are ambiguous
    keep: 12
    // individual fingerprints kept
  };
  var norm = (n) => String(n || "").toLowerCase().replace(/\s+/g, " ").trim();
  var isMe = (n, myName) => /^you$/i.test(String(n).trim()) || myName && norm(n) === norm(myName);
  function evidence(meeting, { myName = "" } = {}) {
    const caps = (meeting.captions || []).filter((c) => c.name && !isIconText(c.name) && !isMe(c.name, myName));
    const all = (meeting.captions || []).filter((c) => c.name && !isIconText(c.name));
    const out = /* @__PURE__ */ new Map();
    for (const s of (meeting.voiceSegs || []).filter((x) => x.s !== "m")) {
      const mine = caps.filter((c) => c.t - LEARN.lead <= s.t0 && (c.t2 ?? c.t) + LEARN.tail >= s.t1);
      if (new Set(mine.map((c) => norm(c.name))).size !== 1) continue;
      const who = norm(mine[0].name);
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
  function learnFromMeeting(meeting, people, { myName = "", blocked = [] } = {}) {
    const report = { meeting: meeting.id, learned: [], skipped: [] };
    if (!meeting?.voiceSegs?.length || !meeting?.captions?.length) {
      report.skipped.push({ why: !meeting?.captions?.length ? "no captions were read in this meeting" : "no voice pieces were recorded" });
      return { list: people, changed: false, report };
    }
    const ev = evidence(meeting, { myName });
    const found = [];
    for (const [key2, { name, segs }] of ev) {
      const vecs = cleaned(segs);
      const secs = vecs.reduce((a, x) => a + (x.s.t1 - x.s.t0), 0);
      if (vecs.length < LEARN.minPieces || secs < LEARN.minSecs) {
        report.skipped.push({ name, why: `only ${vecs.length} clean pieces (${secs.toFixed(0)} s)` });
        continue;
      }
      found.push({ key: key2, name, vecs, secs, centroid: mean(vecs.map((x) => x.v)) });
    }
    const bad = /* @__PURE__ */ new Set();
    for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) if (cosine(found[i].centroid, found[j].centroid) >= LEARN.twin) bad.add(i), bad.add(j);
    let list = [...people];
    found.forEach((f, i) => {
      if (isBlocked(blocked, f.name, f.centroid)) {
        report.skipped.push({ name: f.name, why: "you asked not to learn this voice" });
        return;
      }
      if (bad.has(i)) {
        report.skipped.push({ name: f.name, why: "another speaker in this meeting sounded the same, so it was unclear who was who" });
        return;
      }
      const idx = list.findIndex((p) => norm(p.name) === f.key);
      if (idx < 0) {
        const adopted = adoptName(list, f.centroid, f.name);
        if (adopted) {
          list = adopted;
          report.learned.push({ name: f.name, secs: Math.round(f.secs), total: 0, ready: false, adopted: true });
          return;
        }
      }
      const existing = idx >= 0 ? list[idx] : null;
      if (existing && !existing.auto) {
        report.skipped.push({ name: f.name, why: "you recorded this voice yourself, so it is left as it is" });
        return;
      }
      const rival = list.find((p) => p !== existing && (!p.auto || p.ready) && cosine(unpack(p.centroid), f.centroid) >= LEARN.twin && norm(p.name) !== f.key);
      if (rival) {
        report.skipped.push({ name: f.name, why: `sounds the same as ${rival.name}, so it was not learned` });
        return;
      }
      if (existing?.learnedFrom?.includes(meeting.id)) return;
      const step = Math.max(1, Math.floor(f.vecs.length / LEARN.keep));
      const fresh = f.vecs.filter((_, k) => k % step === 0).map((x) => pack(x.v)).slice(0, LEARN.keep);
      let rec2;
      if (existing) {
        const w = existing.secs || 1;
        const c = mean([scale(unpack(existing.centroid), w), scale(f.centroid, f.secs)]);
        rec2 = { ...existing, centroid: pack(c), windows: [...existing.windows || [], ...fresh].slice(-LEARN.keep * 2), secs: Math.round(w + f.secs), meetings: (existing.meetings || 1) + 1, learnedFrom: [...existing.learnedFrom || [], meeting.id].slice(-50), updated: Date.now() };
      } else {
        rec2 = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: f.name, lang: "free", langs: ["free"], centroid: pack(f.centroid), windows: fresh, secs: Math.round(f.secs), meetings: 1, auto: true, learnedFrom: [meeting.id], created: Date.now() };
      }
      rec2.ready = rec2.secs >= LEARN.readySecs && rec2.meetings >= LEARN.readyMeetings;
      if (existing) list[idx] = rec2;
      else list = [...list, rec2];
      report.learned.push({ name: f.name, secs: Math.round(f.secs), total: rec2.secs, ready: rec2.ready, isNew: !existing });
    });
    return { list, changed: report.learned.length > 0, report };
  }
  var scale = (v, k) => Float32Array.from(v, (x) => x * k);
  var isAnon = (p) => /^Unnamed voice \d+$/.test(p?.name || "");
  function learnRecurring(meeting, people, { blocked = [] } = {}) {
    const report = { meeting: meeting.id, updated: [], created: [], skipped: [] };
    const segs = meeting.voiceSegs || [];
    if (segs.length < 8) {
      report.skipped.push({ why: "too little speech was fingerprinted in this meeting" });
      return { list: people, changed: false, report };
    }
    const assigned = /* @__PURE__ */ new Map();
    const unknown = [];
    for (const s of segs) {
      const v = unpack(s.e);
      const r = people.length ? classify(v, people) : { id: null };
      const owner = r.id ? people.find((p) => p.id === r.id) : null;
      if (owner) {
        if (owner.auto && r.score >= 0.5) (assigned.get(owner.id) || assigned.set(owner.id, []).get(owner.id)).push({ s, v });
      } else unknown.push(s);
    }
    let list = [...people];
    const secsOf = (xs) => xs.reduce((a, x) => a + (x.s.t1 - x.s.t0), 0);
    for (const [id, items] of assigned) {
      const i = list.findIndex((p2) => p2.id === id);
      const p = list[i];
      if (p.learnedFrom?.includes(meeting.id)) continue;
      const vecs = cleaned(items.map((x) => x.s));
      const secs = secsOf(vecs);
      if (vecs.length < 4 || secs < 8) continue;
      const w = p.secs || 1;
      const c = mean([scale(unpack(p.centroid), w), scale(mean(vecs.map((x) => x.v)), secs)]);
      const step = Math.max(1, Math.floor(vecs.length / 6));
      const rec2 = { ...p, centroid: pack(c), windows: [...p.windows || [], ...vecs.filter((_, k) => k % step === 0).map((x) => pack(x.v)).slice(0, 6)].slice(-LEARN.keep * 2), secs: Math.round(w + secs), meetings: (p.meetings || 1) + 1, learnedFrom: [...p.learnedFrom || [], meeting.id].slice(-50), updated: Date.now() };
      rec2.ready = rec2.secs >= LEARN.readySecs && rec2.meetings >= LEARN.readyMeetings;
      list[i] = rec2;
      report.updated.push({ name: p.name, secs: Math.round(secs), total: rec2.secs, ready: rec2.ready });
    }
    if (unknown.length >= 6) {
      const step = Math.max(1, Math.ceil(unknown.length / 300));
      const sample = unknown.filter((_, i) => i % step === 0);
      let next = Math.max(0, ...list.map((p) => Number((p.name.match(/^Unnamed voice (\d+)$/) || [])[1]) || 0)) + 1;
      for (const g of clusterVoices(sample)) {
        const members = g.members.map((i) => sample[i]);
        const vecs = cleaned(members);
        const secs = secsOf(vecs) * step;
        if (vecs.length < LEARN.minPieces || secs < LEARN.minSecs) continue;
        const c = mean(vecs.map((x) => x.v));
        if (isBlocked(blocked, "", c)) {
          report.skipped.push({ why: "a voice you asked not to learn was heard" });
          continue;
        }
        if (list.some((p) => cosine(unpack(p.centroid), c) >= 0.6)) {
          report.skipped.push({ why: "a group of pieces sounded like an existing voice but not clearly enough, so it was left out" });
          continue;
        }
        const stride = Math.max(1, Math.floor(vecs.length / LEARN.keep));
        list = [...list, { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `Unnamed voice ${next++}`, lang: "free", langs: ["free"], centroid: pack(c), windows: vecs.filter((_, k) => k % stride === 0).map((x) => pack(x.v)).slice(0, LEARN.keep), secs: Math.round(secs), meetings: 1, auto: true, ready: false, learnedFrom: [meeting.id], created: Date.now() }];
        report.created.push({ name: list.at(-1).name, secs: Math.round(secs) });
      }
    }
    return { list, changed: report.updated.length + report.created.length > 0, report };
  }
  function adoptName(list, centroid, name) {
    const i = list.findIndex((p) => isAnon(p) && cosine(unpack(p.centroid), centroid) >= 0.6);
    if (i < 0) return null;
    const next = [...list];
    next[i] = { ...next[i], name, updated: Date.now() };
    return next;
  }
  function isBlocked(blocked, name, centroid) {
    const n = norm(name);
    return (blocked || []).some((b) => n && !isAnon({ name }) && norm(b.name) === n || centroid && b.centroid && cosine(unpack(b.centroid), centroid) >= 0.7);
  }

  // src/meetend.js
  var MEET_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;

  // src/adapters/index.js
  var OTHER_SITES = [
    { name: "Zoom (web client)", matches: ["https://app.zoom.us/*", "https://*.zoom.us/wc/*", "https://zoom.us/wc/*"] },
    { name: "Microsoft Teams", matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*", "https://teams.cloud.microsoft/*"] },
    { name: "Webex", matches: ["https://*.webex.com/*"] },
    { name: "Whereby", matches: ["https://whereby.com/*"] },
    { name: "Jitsi Meet", matches: ["https://meet.jit.si/*", "https://8x8.vc/*"] },
    { name: "GoTo Meeting", matches: ["https://app.goto.com/*", "https://app.gotomeeting.com/*"] },
    { name: "BlueJeans", matches: ["https://app.bluejeans.com/*"] },
    { name: "Amazon Chime", matches: ["https://app.chime.aws/*"] },
    { name: "Zoho Meeting", matches: ["https://meeting.zoho.com/*", "https://meeting.zoho.in/*", "https://meeting.zoho.eu/*"] },
    { name: "Skype for Web", matches: ["https://web.skype.com/*"] }
  ];
  var hostOf = (pattern) => pattern.replace(/^https:\/\//, "").split("/")[0];
  var hostMatches = (pattern, hostname) => {
    const h = hostOf(pattern);
    return h.startsWith("*.") ? hostname === h.slice(2) || hostname.endsWith(h.slice(1)) : hostname === h;
  };
  function siteFor(hostname) {
    return OTHER_SITES.find((s) => s.matches.some((m) => hostMatches(m, hostname))) || null;
  }
  var isMeetingSite = (hostname) => hostname === "meet.google.com" || !!siteFor(hostname);

  // src/room.js
  function meetingFor(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname === "meet.google.com") return MEET_CODE.test(u.pathname) ? { app: "Google Meet" } : null;
    if (isMeetingSite(u.hostname)) return { app: siteFor(u.hostname)?.name || u.hostname };
    return null;
  }
  var isMeetingUrl = (url) => !!meetingFor(url);
  var roomFor = (url, choice) => typeof choice === "boolean" ? choice : !isMeetingUrl(url);

  // src/wav.js
  function encodeWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (off2, s) => [...s].forEach((c, i) => v.setUint8(off2 + i, c.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, x < 0 ? x * 32768 : x * 32767, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // src/voice/samples.js
  var DB = "debrief-voice";
  var SR = 16e3;
  var CLIP_SEC = 8;
  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("pieces");
        r.result.createObjectStore("samples");
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
        t.oncomplete = () => resolve(out && typeof out === "object" && "result" in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
  var fromInt16 = (i16) => Float32Array.from(i16, (x) => x / 32768);
  var pieceKey = (meetingId, t0, origin) => `${meetingId}|${origin === "m" ? "m" : ""}${Math.round(t0 * 100)}`;
  var getPiece = (key2) => tx("pieces", "readonly", (s) => s.get(key2));
  async function deletePieces(meetingId) {
    await tx("pieces", "readwrite", (s) => s.delete(IDBKeyRange.bound(`${meetingId}|`, `${meetingId}|\uFFFF`)));
  }
  var putSample = (personId, blob) => tx("samples", "readwrite", (s) => s.put(blob, personId));
  var hasSample = async (personId) => await tx("samples", "readonly", (s) => s.count(personId)) > 0;
  function makeClip(pieces) {
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

  // src/voice/sampling.js
  async function saveSamples(meetingId, meeting, people) {
    try {
      if (!meeting) return;
      const todo = [];
      for (const p of people) if (p.auto && !await hasSample(p.id)) todo.push(p);
      if (!todo.length) return;
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
      await deletePieces(meetingId).catch(() => {
      });
    }
  }

  // src/alerts.js
  function classifyError(err) {
    const e = String(err || "");
    const model = (e.match(/model:\s*([\w.-]+)/i) || [])[1];
    const retry = (e.match(/retry in\s*([\dhms.]+)/i) || [])[1];
    if (/API key not valid|API_KEY_INVALID|\b(401|403)\b/i.test(e)) {
      return {
        kind: "key",
        title: "API key rejected",
        detail: "Google says the key is invalid or lacks access. Check it in Debrief settings. Audio is kept and will retry."
      };
    }
    if (/^MIC_SILENT/.test(e)) {
      return {
        kind: "mic",
        title: "Your microphone is silent",
        detail: "Debrief has heard nothing from your microphone for a minute. Check the right microphone is chosen in Settings \u2192 General \u2192 Microphone and that Windows lets Chrome use it. Other people are still being recorded."
      };
    }
    if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(e)) {
      const reset = retry ? `, resets in about ${retry.replace(/\.\d+s?$/, "")}` : "";
      return {
        kind: "quota",
        title: "API limit reached",
        detail: `${model ? `${model}: ` : ""}free-tier limit used up${reset}. Debrief tries other models first; chunks that still fail are kept and retried from the MOM page.`
      };
    }
    return null;
  }

  // src/usage.js
  function dayKey(date = /* @__PURE__ */ new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
  }
  var rowKey = (e) => `${e.provider}|${e.model || "-"}|${e.kind}`;
  function addEntry(usage, e, now = /* @__PURE__ */ new Date()) {
    const next = { ...usage || {} };
    const day = dayKey(now);
    const rows = { ...next[day] || {} };
    const key2 = rowKey(e);
    const row = { req: 0, fail: 0, rl: 0, tin: 0, tout: 0, audioSec: 0, ...rows[key2] || {} };
    row.req += e.req || 0;
    row.fail += e.fail ? 1 : 0;
    row.rl += e.rl ? 1 : 0;
    row.tin += e.tin || 0;
    row.tout += e.tout || 0;
    row.audioSec += e.audioSec || 0;
    rows[key2] = row;
    next[day] = rows;
    const keep = new Date(now.getTime() - 62 * 864e5);
    for (const d of Object.keys(next)) if (d < dayKey(keep)) delete next[d];
    return next;
  }

  // src/jobstate.js
  var ACTIVE = ["queued", "transcribing-retry", "writing", "emailing"];
  var isActive = (m) => ACTIVE.includes(m?.job?.state);
  var STALE_MS = 3e4;
  function stuckJobs(meetings, now = Date.now()) {
    return meetings.filter((m) => m && isActive(m) && !m.job?.held && now - (m.job?.beat || 0) > STALE_MS).map((m) => m.id);
  }

  // src/store.js
  var DEFAULTS = {
    myName: "",
    captureMic: true,
    meetingLanguages: [],
    // languages to expect (codes from languages.js); empty = automatic
    meetingLanguage: "auto",
    // older single setting (auto | hinglish | malayalam), still honoured when the list is empty
    pillOnPage: false,
    // also show the pill inside the Meet page
    emailSecret: "",
    // made up by Debrief, never typed; the relay script locks itself to it on first use
    emailWebhook: "",
    // Google Apps Script web app URL (apps-script/Code.gs)
    emailTo: "",
    // optional; the script only allows you and its ALLOWED list
    emailAuto: true,
    // email the MOM as soon as it is written
    emailPdf: true,
    // attach the MOM as PDF
    emailWord: false,
    // attach the MOM as Word (.doc)
    emailMd: false,
    // attach the MOM as Markdown
    emailTranscript: false,
    // attach the transcript as .txt
    autoStop: true,
    // stop recording by itself when the meeting is over
    autoStopQuietMin: 10,
    // ...or after this many silent minutes (0 = never)
    usageLimits: "",
    // one "model=daily requests" per line; learned from 429s too
    usdInr: 88,
    // rupees per US dollar, to show the 'cost if paid' estimate in rupees
    usagePrices: "",
    // one "model=USD per 1M input,USD per 1M output" per line
    dictAutoAlias: false,
    // accept clear-cut learned fixes (3+ sightings) without asking
    dictionary: "",
    // names and terms, one per line: Right | misheard, as, this
    minutesMode: "thorough",
    // thorough = extract, write, then check; quick = one pass
    sttGeminiChunk: "standard",
    // standard = 100-150 s chunks; long = about 240 s (fewer requests per meeting)
    minutesFormat: "amnex",
    // amnex = official Amnex template (Print/PDF, Word, email); standard = Debrief's own layout
    myOrgDomains: "",
    // email domains of the System Integrator side (comma separated); empty = the domain of "Send to", else one list
    peopleDirectory: "",
    // one per line: Name | Honorific | Department | Designation | Organisation [| Chair]
    shareList: "",
    // default people to share the minutes with
    shareGroups: "",
    // per recurring meeting: "title words | a@x.com, b@y.com"
    shareMode: "review",
    // review = only I get it until I press Share; auto = send to them too
    shareHow: "to",
    // to | cc | bcc
    shareDomains: false,
    // script helper: allow whole company domains instead of single addresses
    calendarLookup: true,
    // ask the relay who was invited (needs the calendar permission)
    meetCaptions: "read",
    // read speaker names from Meet's captions: off | read (when you have captions on) | auto (turn them on)
    otherSites: true,
    // use the page features (amber dot, mute follow, auto-stop) on Zoom, Teams, Webex and other meeting apps
    voiceOn: false,
    // recognise who is speaking, using voices enrolled in Settings
    voiceSamples: true,
    // keep a short audio clip of each unnamed voice so it can be played to name it (off: no audio is kept)
    voiceLearn: false,
    // learn voices on its own from Meet's captions (needs captions read) and fingerprints of the meeting
    followMeetMute: true,
    // ignore my mic while Meet's own mic button is muted
    momLanguage: "English",
    geminiKey: "",
    // shared by Gemini transcription and the Gemini MOM writer
    geminiKey2: "",
    // optional backup key from a different Google Cloud project
    sttProvider: "gemini",
    // gemini | sarvam | deepgram | openai
    sttGeminiModel: "gemini-3.5-transcribe",
    sarvamKey: "",
    sarvamModel: "saaras:v4",
    sarvamMode: "codemix",
    // codemix | transcribe | translate
    sarvamLanguage: "unknown",
    deepgramKey: "",
    deepgramModel: "nova-3",
    sttBase: "https://api.groq.com/openai/v1",
    sttKey: "",
    sttModel: "whisper-large-v3",
    sttPrompt: "Hinglish office meeting. Hindi in Devanagari, English words in English.",
    llmProvider: "gemini",
    // gemini | anthropic | openai
    anthropicKey: "",
    anthropicModel: "claude-opus-5-5",
    oaBase: "https://api.openai.com/v1",
    oaKey: "",
    oaModel: "",
    geminiModel: "gemini-3.8-flash"
  };
  async function getSettings() {
    const { settings, learned, voices } = await chrome.storage.local.get(["settings", "learned", "voices"]);
    const learnedNames = Object.entries(learned?.names || {}).sort((a, b) => a[1] - b[1]).map(([n]) => n).slice(-80);
    return { ...DEFAULTS, ...settings || {}, learnedNames, voices: voices || [] };
  }
  function sttReady(s) {
    if (s.sttProvider === "gemini") return !!s.geminiKey && !!s.sttGeminiModel;
    if (s.sttProvider === "sarvam") return !!s.sarvamKey;
    if (s.sttProvider === "deepgram") return !!s.deepgramKey;
    return !!s.sttBase && !!s.sttModel;
  }
  var key = (id) => `meeting:${id}`;
  async function getMeeting(id) {
    const r = await chrome.storage.local.get(key(id));
    return r[key(id)] || null;
  }
  async function saveMeeting(m) {
    await chrome.storage.local.set({ [key(m.id)]: m });
  }
  async function addMeetingId(id) {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    await chrome.storage.local.set({ meetingIds: [id, ...meetingIds] });
  }
  async function getState() {
    const { rec: rec2 } = await chrome.storage.session.get("rec");
    return rec2 || { recording: false };
  }
  async function setState(rec2) {
    await chrome.storage.session.set({ rec: rec2 });
  }
  async function setSetting(patch) {
    const { settings } = await chrome.storage.local.get("settings");
    const { learnedNames, voices, ...clean } = patch;
    await chrome.storage.local.set({ settings: { ...settings || {}, ...clean } });
  }
  async function saveVoices(list) {
    await chrome.storage.local.set({ voices: list });
  }
  async function getBlockedVoices() {
    const { voiceBlock } = await chrome.storage.local.get("voiceBlock");
    return voiceBlock || [];
  }
  async function getEmailNames() {
    const { emailNames } = await chrome.storage.local.get("emailNames");
    return emailNames || {};
  }
  async function saveEmailNames(map) {
    await chrome.storage.local.set({ emailNames: map });
  }
  var nameQueue = Promise.resolve();
  function mergeEmailNames(found) {
    nameQueue = nameQueue.catch(() => {
    }).then(async () => {
      const cur = await getEmailNames();
      const fresh = Object.entries(found || {}).filter(([k]) => !cur[k]);
      if (!fresh.length) return cur;
      const next = { ...cur, ...Object.fromEntries(fresh) };
      await saveEmailNames(next);
      return next;
    });
    return nameQueue;
  }

  // src/background.js
  chrome.runtime.onInstalled.addListener((d) => {
    if (d.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?restart=1") });
  });
  var quiet = (p) => Promise.resolve(p).catch(() => {
  });
  var TIP_IDLE = "Debrief";
  var TIP_CALL = "A call is on. Click to record.";
  var TIP_ATTN = "Debrief needs attention";
  var ICON_IDLE = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png" };
  var ICON_GLOW = { 16: "icons/icon16-glow.png", 32: "icons/icon32-glow.png", 48: "icons/icon48-glow.png" };
  var setIcon = (tabId, glow) => quiet(chrome.action.setIcon({ tabId, path: glow ? ICON_GLOW : ICON_IDLE }));
  var setBadge = (tabId, text, color) => {
    const t = tabId == null ? {} : { tabId };
    if (color) quiet(chrome.action.setBadgeBackgroundColor({ ...t, color }));
    quiet(chrome.action.setBadgeText({ ...t, text }));
  };
  var setTip = (tabId, title) => quiet(chrome.action.setTitle(tabId == null ? { title } : { tabId, title }));
  var GLOW_MS = 600;
  var glowTabs = /* @__PURE__ */ new Set();
  var glowTimer = null;
  var glowPhase = false;
  function endGlowTimer() {
    if (glowTabs.size || !glowTimer) return;
    clearInterval(glowTimer);
    glowTimer = null;
    glowPhase = false;
  }
  function startGlow(tabId) {
    if (glowTabs.has(tabId)) return;
    if (!glowTimer) glowPhase = true;
    glowTabs.add(tabId);
    setIcon(tabId, glowPhase);
    glowTimer ||= setInterval(() => {
      glowPhase = !glowPhase;
      for (const t of glowTabs) setIcon(t, glowPhase);
    }, GLOW_MS);
  }
  function stopGlow(tabId) {
    if (!glowTabs.delete(tabId)) return;
    setIcon(tabId, false);
    endGlowTimer();
  }
  function showCallOn(tabId) {
    setBadge(tabId, "\u25CF", "#F59E0B");
    setTip(tabId, TIP_CALL);
    startGlow(tabId);
  }
  function showCallOff(tabId) {
    stopGlow(tabId);
    setBadge(tabId, "");
    setTip(tabId, TIP_IDLE);
  }
  var fmtElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1e3));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  var rec = null;
  var recTimer = null;
  function paintRec() {
    if (!rec) return;
    const bad = rec.attention;
    const tip = bad ? TIP_ATTN : `${rec.paused ? "Paused" : "Recording"} \xB7 ${fmtElapsed(Date.now() - rec.startedAt)}`;
    for (const t of [null, rec.tabId]) {
      setBadge(t, bad ? "!" : rec.paused ? "II" : "REC", bad ? "#1d1f24" : rec.paused ? "#c25a00" : "#c8281c");
      setTip(t, tip);
    }
  }
  function showRec(tabId, startedAt, attention = false) {
    stopGlow(tabId);
    rec = { tabId, startedAt, attention };
    paintRec();
    clearInterval(recTimer);
    recTimer = setInterval(paintRec, 5e3);
  }
  function setAttention(on) {
    if (!rec || rec.attention === on) return;
    rec.attention = on;
    paintRec();
  }
  function hideRec(tabId) {
    clearInterval(recTimer);
    recTimer = null;
    rec = null;
    for (const t of [null, tabId]) {
      setBadge(t, "");
      setTip(t, TIP_IDLE);
    }
  }
  getState().then((st) => {
    if (st.recording && !st.stopping) {
      showRec(st.tabId, st.startedAt, !!st.alert);
      if (st.paused && rec) {
        rec.paused = true;
        paintRec();
      }
    }
  }, () => {
  });
  var chain = Promise.resolve();
  var serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {
    });
    return p;
  };
  var mutateState = (fn) => serial(async () => {
    const next = await fn(await getState());
    if (next) await setState(next);
    return next;
  });
  async function updateMeeting(id, fn) {
    return serial(async () => {
      const m = await getMeeting(id);
      if (!m) return;
      fn(m);
      await saveMeeting(m);
    });
  }
  async function raiseAlert(meetingId, err) {
    const a = classifyError(err);
    if (!a) return;
    let fresh = false;
    await mutateState((st) => {
      if (!st.recording || st.stopping) return null;
      fresh = !st.alert || st.alert.kind !== a.kind || Date.now() - st.alert.notifiedAt > 10 * 60 * 1e3;
      return { ...st, alert: { ...a, at: Date.now(), notifiedAt: fresh ? Date.now() : st.alert.notifiedAt } };
    });
    setAttention(true);
    if (fresh) {
      chrome.notifications?.create(`debrief-${a.kind}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: `Debrief: ${a.title}`,
        message: a.detail,
        priority: 2
      });
    }
  }
  async function clearAlert() {
    let had = false;
    await mutateState((st) => (had = !!st.alert, st.alert ? { ...st, alert: null } : null));
    if (had) setAttention(false);
  }
  async function ensureOffscreen() {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctxs.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Record meeting tab audio and microphone for transcription"
    });
  }
  async function closeOffscreen() {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!ctxs.length) return;
    const busy = await chrome.runtime.sendMessage({ target: "offscreen", type: "job-count" }).catch(() => null);
    if (busy?.count > 0) return;
    await chrome.offscreen.closeDocument();
  }
  async function jobCommand(type, msg, { create = true } = {}) {
    if (create) await ensureOffscreen();
    else if (!(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) return { ok: true, running: false };
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", type, ...msg }) || { ok: false };
    } catch {
      return { ok: false };
    }
  }
  async function startJob(id) {
    await updateMeeting(id, (m) => {
      m.job = { state: "queued", beat: Date.now(), error: null };
    });
    return jobCommand("job-run", { id });
  }
  async function resumeJobs() {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    const rows = await chrome.storage.local.get(meetingIds.slice(0, 30).map((i) => `meeting:${i}`));
    for (const id of stuckJobs(Object.values(rows))) await jobCommand("job-run", { id, resume: true });
  }
  resumeJobs().catch(() => {
  });
  chrome.runtime.onStartup?.addListener(() => resumeJobs().catch(() => {
  }));
  var cleanTitle = (t = "") => t.replace(/^Meet\s*[-–]\s*/i, "").replace(/\s*[-–]\s*Google Meet$/i, "").trim() || "Meeting";
  var starting = false;
  async function start(msg) {
    if (starting) return { ok: false, error: "A recording is already starting." };
    starting = true;
    try {
      return await startInner(msg);
    } finally {
      starting = false;
    }
  }
  async function startInner(msg) {
    const st = await getState();
    if (st.recording) return { ok: false, error: "Already recording another tab." };
    const settings = await getSettings();
    const room = roomFor(msg.url, msg.room);
    const id = `m${Date.now()}`;
    await saveMeeting({
      id,
      room,
      title: cleanTitle(msg.title),
      url: msg.url,
      startedAt: Date.now(),
      endedAt: null,
      segments: [],
      errors: [],
      mom: "",
      stt: settings.sttProvider
    });
    await addMeetingId(id);
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId: msg.streamId, settings: { ...settings, roomMode: room, captureMic: settings.captureMic || room }, meetingId: id }).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) {
      await closeOffscreen();
      await updateMeeting(id, (m) => {
        m.endedAt = Date.now();
        m.errors.push(`Start failed: ${r?.error}`);
      });
      return { ok: false, error: r?.error || "Recorder did not start." };
    }
    await mutateState(() => ({ recording: true, room, meetingId: id, tabId: msg.tabId, startedAt: Date.now(), micOn: r.mic, micWanted: r.mic, meetMuted: null, mic: r.mic, micError: r.micError || null, meetCode: (msg.url || "").match(MEET_CODE)?.[0] || null }));
    await chrome.storage.session.set({ quietSince: null, heard: false });
    chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["dist/pill.js"] }).catch(() => {
    });
    showRec(msg.tabId, Date.now());
    return { ok: true };
  }
  async function setWindowFullscreen(windowId, want, auto) {
    const id = windowId ?? (await chrome.windows.getLastFocused()).id;
    const w = await chrome.windows.get(id);
    const { fsPrev = {} } = await chrome.storage.session.get("fsPrev");
    const on = typeof want === "boolean" ? want : w.state !== "fullscreen";
    if (on) {
      if (w.state === "fullscreen") return { ok: true, fullscreen: true };
      fsPrev[id] = w.state || "normal";
      await chrome.storage.session.set({ fsPrev });
      await chrome.windows.update(id, { state: "fullscreen" });
      return { ok: true, fullscreen: true };
    }
    if (w.state !== "fullscreen") return { ok: true, fullscreen: false };
    if (auto && !(id in fsPrev)) return { ok: true, fullscreen: true };
    const back = fsPrev[id] && fsPrev[id] !== "fullscreen" ? fsPrev[id] : "normal";
    delete fsPrev[id];
    await chrome.storage.session.set({ fsPrev });
    await chrome.windows.update(id, { state: back });
    return { ok: true, fullscreen: false };
  }
  async function setPaused(want) {
    let changed = false;
    const now = Date.now();
    await mutateState((st2) => {
      if (!st2.recording || st2.stopping) return null;
      const on = typeof want === "boolean" ? want : !st2.paused;
      if (on === !!st2.paused) return null;
      changed = true;
      return { ...st2, paused: on, pausedAt: on ? now : null };
    });
    const st = await getState();
    if (!changed || !st.recording) return { ok: true, paused: !!st.paused };
    await chrome.runtime.sendMessage({ target: "offscreen", type: "pause", on: !!st.paused }).catch(() => {
    });
    const sec = Math.max(0, Math.round((now - st.startedAt) / 1e3));
    await updateMeeting(st.meetingId, (m) => {
      const list = m.pauses ||= [];
      if (st.paused) list.push({ from: sec, to: null });
      else if (list.length && list.at(-1).to == null) list.at(-1).to = sec;
    });
    if (!rec) showRec(st.tabId, st.startedAt, !!st.alert);
    rec.paused = !!st.paused;
    paintRec();
    await chrome.storage.session.set({ quietSince: now });
    return { ok: true, paused: !!st.paused };
  }
  async function learnVoices(meetingId) {
    const s = await getSettings();
    const m = await getMeeting(meetingId);
    if (!s.voiceLearn || !m) {
      await saveSamples(meetingId, null, []).catch(() => {
      });
      return;
    }
    const blocked = await getBlockedVoices();
    const r = learnFromMeeting(m, s.voices || [], { myName: s.myName, blocked });
    const r2 = learnRecurring(m, r.list, { blocked });
    if (r.changed || r2.changed) await saveVoices(r2.list);
    await saveSamples(meetingId, s.voiceSamples ? m : null, r2.list).catch(() => {
    });
    await updateMeeting(meetingId, (mm) => {
      mm.voiceLearn = { ...r.report, recurring: r2.report };
    });
  }
  var stopping = null;
  function stop(opts = {}) {
    stopping ||= (async () => {
      let st;
      await mutateState((cur) => {
        st = cur;
        return cur.recording && !cur.stopping ? { ...cur, stopping: true } : null;
      });
      if (!st?.recording) return { ok: true };
      try {
        await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
      } catch {
      }
      await updateMeeting(st.meetingId, (m) => {
        m.endedAt = Date.now();
        const open2 = (m.pauses || []).at(-1);
        if (open2 && open2.to == null) open2.to = Math.round((m.endedAt - m.startedAt) / 1e3);
      });
      await learnVoices(st.meetingId).catch(() => {
      });
      await startJob(st.meetingId).catch(() => {
      });
      await mutateState(() => ({ recording: false }));
      hideRec(st.tabId);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${st.meetingId}`), active: !opts.background });
      return { ok: true };
    })().finally(() => stopping = null);
    return stopping;
  }
  async function applyMic(patch = {}) {
    const { followMeetMute } = await getSettings();
    let eff = false;
    let changed = false;
    let cur = null;
    let noted = "";
    await mutateState((st) => {
      if (!st.recording || st.stopping) return null;
      cur = { ...st, ...patch };
      if ("meetMuted" in patch && patch.meetMuted !== st.meetMuted) noted = `Meet mic: ${patch.meetMuted === true ? "muted" : patch.meetMuted === false ? "unmuted" : "state not detected"} at +${Math.round((Date.now() - (st.startedAt || Date.now())) / 1e3)}s${followMeetMute ? "" : " (following Meet is off)"}`;
      eff = !!cur.micWanted && !!cur.mic && !(followMeetMute && !cur.room && cur.meetMuted === true);
      changed = eff !== !!st.micOn;
      return cur;
    });
    if (!cur) return { ok: false };
    if (noted && cur.meetingId) updateMeeting(cur.meetingId, (m) => (m.debug ||= []).push(`${noted}; Debrief mic ${eff ? "on" : "off"}`)).catch(() => {
    });
    let micOn = cur.micOn;
    if (changed) {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "mic", on: eff }).catch(() => null);
      micOn = r?.micOn ?? false;
      await mutateState((st) => st.recording && !st.stopping ? { ...st, micOn } : null);
    }
    return { ok: true, micOn, micWanted: !!cur.micWanted };
  }
  async function autoStop(reason) {
    const st = await getState();
    if (!st.recording || st.stopping) return;
    await updateMeeting(st.meetingId, (m) => (m.debug ||= []).push(`auto-stop: ${reason}`));
    await stop({ background: true });
    chrome.notifications?.create("debrief-autostop", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Debrief stopped recording",
      message: `${reason} Writing the minutes now.`
    });
  }
  var PAGE_MAY = /* @__PURE__ */ new Set(["window-fullscreen", "whoami", "meet-mute", "meet-ended", "meet-snap", "in-call", "pill-state", "mic", "stop", "set-follow", "dismiss-alert"]);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== "bg") return;
    if (sender.id !== chrome.runtime.id) return;
    const ownPage = !sender.tab || (sender.url || "").startsWith(chrome.runtime.getURL(""));
    if (!ownPage && !PAGE_MAY.has(msg.type)) return;
    const handlers = {
      start: () => start(msg),
      stop: () => stop(),
      // Full screen for the whole browser window. Chrome keeps a tab that is being captured from taking the window full
      // screen when the page asks (Meet's "Full screen" button), so Debrief does it through the window itself. A page
      // sets `auto` when it only follows its own full screen: then Debrief only undoes what it did itself.
      "window-fullscreen": () => setWindowFullscreen(sender.tab?.windowId, typeof msg.on === "boolean" ? msg.on : void 0, !!msg.auto),
      mic: () => applyMic({ micWanted: !!msg.on }),
      pause: () => setPaused(typeof msg.on === "boolean" ? msg.on : void 0),
      "mic-refresh": () => applyMic(),
      "meet-mute": () => applyMic({ meetMuted: msg.muted }),
      whoami: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
      level: async () => {
        await chrome.storage.session.set({ levels: { tab: msg.tab, mic: msg.mic, ctx: msg.ctx, at: Date.now() } });
        const now = Date.now();
        if (Math.max(msg.tab || 0, msg.mic || 0) >= 0.012) {
          await chrome.storage.session.set({ quietSince: now, heard: true });
          return;
        }
        if ((await getState()).paused) return;
        const { quietSince, heard } = await chrome.storage.session.get(["quietSince", "heard"]);
        if (!heard || !quietSince) return;
        const s = await getSettings();
        const mins = Number(s.autoStopQuietMin);
        if (s.autoStop !== false && mins > 0 && now - quietSince > mins * 6e4) await autoStop(`It was silent for ${mins} minutes.`);
      },
      "meet-ended": async () => {
        const st = await getState();
        if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
        if ((await getSettings()).autoStop === false) return { ok: false };
        await autoStop("The meeting ended.");
        return { ok: true };
      },
      "mic-silent": () => raiseAlert(msg.meetingId, "MIC_SILENT"),
      "job-run": () => jobCommand("job-run", { id: msg.id, force: !!msg.force, reread: !!msg.reread }),
      "job-hold": () => jobCommand("job-hold", { id: msg.id }, { create: false }),
      "job-abort": () => jobCommand("job-abort", { id: msg.id }, { create: false }),
      "offscreen-idle": async () => {
        if (!(await getState()).recording) await closeOffscreen();
        return { ok: true };
      },
      notify: async () => {
        chrome.notifications?.create(String(msg.id || "debrief"), { type: "basic", iconUrl: "icons/icon128.png", title: String(msg.title || "Debrief"), message: String(msg.message || "") });
        return { ok: true };
      },
      // the offscreen document has no chrome.storage, so the job runner reads and writes through here
      store: async () => {
        if (msg.op === "settings") return { ok: true, value: await getSettings() };
        if (msg.op === "getMeeting") return { ok: true, value: await getMeeting(msg.id) };
        if (msg.op === "saveMeeting") return serial(async () => (await saveMeeting(msg.meeting), { ok: true }));
        if (msg.op === "mergeEmailNames") return { ok: true, value: await mergeEmailNames(msg.found) };
        if (msg.op === "emailNames") return { ok: true, value: await getEmailNames() };
        return { ok: false };
      },
      dbg: () => updateMeeting(msg.meetingId, (m) => (m.debug ||= []).push(msg.note)),
      segment: async () => {
        await updateMeeting(msg.meetingId, (m) => m.segments.push(msg.seg));
        await clearAlert();
      },
      "stt-error": async () => {
        await updateMeeting(msg.meetingId, (m) => m.errors.push(msg.error));
        await raiseAlert(msg.meetingId, msg.error);
      },
      usage: () => serial(async () => {
        const { usage, learnedLimits = {} } = await chrome.storage.local.get(["usage", "learnedLimits"]);
        const next = { usage: addEntry(usage, msg.entry) };
        if (msg.entry?.learned) next.learnedLimits = { ...learnedLimits, [msg.entry.learned.model]: msg.entry.learned.limit };
        await chrome.storage.local.set(next);
      }),
      // People and captions sampled from the meeting page: who was there when, and who spoke.
      "meet-snap": async () => {
        const st = await getState();
        if (!st.recording || sender.tab?.id !== st.tabId) return { ok: false };
        const me = (await getSettings()).myName;
        const who = (n) => /^you$/i.test(n) && me ? me : n;
        await updateMeeting(st.meetingId, (m) => {
          const pres = m.presence ||= {};
          for (const n of (msg.names || []).filter((x) => !isIconText(x) && !isMenuText(x))) {
            const k = who(n);
            const p = pres[k];
            if (p) {
              p[1] = msg.t;
              p[2] = (p[2] || 0) + 1;
            } else pres[k] = [msg.t, msg.t, 1];
          }
          if (msg.names) {
          }
          const caps = m.captions ||= [];
          for (const c of msg.captions || []) {
            const name = who(c.name);
            let last = null;
            for (let i = caps.length - 1; i >= 0 && i > caps.length - 40; i--) if (caps[i].name === name) {
              last = caps[i];
              break;
            }
            if (last && c.t - last.t2 < 15 && (c.text.startsWith(last.text) || last.text.startsWith(c.text) || last.text.slice(0, 20) === c.text.slice(0, 20))) {
              last.text = c.text.length >= last.text.length ? c.text : last.text;
              last.t2 = c.t;
            } else caps.push({ t: c.t, t2: c.t, name, text: c.text });
          }
          if (caps.length > 4e3) caps.splice(0, caps.length - 4e3);
        });
        return { ok: true };
      },
      // A page script saw a live call (or the call ended): glow the icon amber unless we are already recording it.
      "in-call": async () => {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false };
        const st = await getState();
        if (st.recording && st.tabId === tabId) return { ok: true };
        if (msg.on) showCallOn(tabId);
        else showCallOff(tabId);
        return { ok: true };
      },
      // Voice fingerprints of the meeting's speech, made by the recorder. Only fingerprints, never audio.
      "voice-seg": async () => {
        const segs = (msg.segs || []).filter((x) => Number.isFinite(x?.t0) && Number.isFinite(x?.t1) && typeof x.e === "string" && x.e.length < 600).map((x) => ({ t0: x.t0, t1: x.t1, e: x.e, ...x.s === "m" ? { s: "m" } : {} })).slice(0, 200);
        if (!segs.length) return { ok: false };
        await updateMeeting(msg.meetingId, (m) => {
          const all = m.voiceSegs ||= [];
          all.push(...segs);
          m.voiceModel = "wespeaker-resnet34-lm";
          if (all.length > 12e3) all.splice(0, all.length - 12e3);
        });
        return { ok: true };
      },
      "dismiss-alert": () => clearAlert(),
      "set-follow": async () => {
        await setSetting({ followMeetMute: !!msg.on });
        return applyMic();
      },
      "pill-state": async () => {
        const rec2 = await getState();
        const { levels } = await chrome.storage.session.get("levels");
        const m = rec2.meetingId ? await getMeeting(rec2.meetingId) : null;
        return { ok: true, rec: rec2, levels: levels || null, counts: { segs: m?.segments.length || 0, errs: m?.errors.length || 0 }, follow: (await getSettings()).followMeetMute !== false, showPill: (await getSettings()).pillOnPage === true, captionMode: (await getSettings()).meetCaptions || "read", otherSites: (await getSettings()).otherSites !== false };
      }
    };
    const h = handlers[msg.type];
    if (!h) return;
    h().then(
      (r) => sendResponse(r ?? { ok: true }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  });
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "toggle-fullscreen") {
      await setWindowFullscreen(tab?.windowId);
      return;
    }
    if (command === "toggle-pause") {
      if ((await getState()).recording) await setPaused();
      return;
    }
    if (command === "toggle-mic") {
      const cur = await getState();
      if (cur.recording) await applyMic({ micWanted: !(cur.micWanted ?? cur.micOn) });
      return;
    }
    if (command !== "toggle-recording") return;
    const st = await getState();
    if (st.recording) return stop();
    if (!tab?.id) return;
    if (!sttReady(await getSettings())) return chrome.runtime.openOptionsPage();
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await start({ streamId, tabId: tab.id, title: tab.title, url: tab.url });
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      stopGlow(tab.id);
      setBadge(tab.id, "!", "#1d1f24");
      setTip(tab.id, `${TIP_ATTN}: could not start (${e.message})`);
    }
  });
  var MEET_CALL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#]|$)/;
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (!info.url && info.status !== "complete") return;
    const st = await getState();
    if (st.recording && st.tabId === tabId) return;
    if (MEET_CALL.test(tab.url || "")) showCallOn(tabId);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!info.url) return;
    const st = await getState();
    if (!st.recording || st.stopping || tabId !== st.tabId || !st.meetCode) return;
    if (info.url.includes(st.meetCode)) return;
    if ((await getSettings()).autoStop === false) return;
    await autoStop("You left the meeting page.");
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    glowTabs.delete(tabId);
    endGlowTimer();
    const st = await getState();
    if (st.recording && st.tabId === tabId) stop();
  });
})();
