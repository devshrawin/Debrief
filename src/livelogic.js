// The live page's logic with no DOM in it, so it is tested in node (test/pro-live.mjs).
// Lines arrive two ways, the background's broadcast and a re-read of the stored meeting. Both go through LiveStore, which
// keeps them in time order and never shows the same line twice.
import { fmtTime } from './store.js';
import { chunkSecs } from './chunker.js';
import { cleanTranscript, makeDeduper } from './sttclean.js';
import { structuredSystem, structuredUser } from './structured.js';
import { wordsOf } from './prompt.js';
import { parseDictionary } from './dictionary.js';
import { languagesOf, joinNames } from './languages.js';

export const MIN_WORDS = 60; // under this there is nothing worth summarising yet
export const POLL_MS = 5000;
export const FOLLOW_SLACK = 48; // px from the bottom that still counts as "at the bottom"

// What a line is called on screen.
export function whoOf(it, { myName = '', room = false } = {}) {
  if (typeof it.spk === 'string' && it.spk.trim()) return it.spk.trim();
  if (it.src === 'me') return room ? 'Room' : myName || 'Me';
  return 'Others';
}

// Same line from a broadcast and from storage = same key.
export const keyOf = (kind, it) => `${kind}|${it.t}|${it.src || ''}|${it.text}`;

// Consecutive lines of one speaker share a label; screen notes never join a group.
export const continues = (prev, row) => !!prev && prev.kind === 'line' && row.kind === 'line' && prev.who === row.who;

export function groupLines(rows) {
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && continues(g.lines[g.lines.length - 1], r)) g.lines.push(r);
    else groups.push({ who: r.who, kind: r.kind, src: r.src, lines: [r] });
  }
  return groups;
}

export class LiveStore {
  constructor({ myName = '', room = false } = {}) {
    this.opts = { myName, room };
    this.rows = []; // sorted by t; equal times keep arrival order
    this.keys = new Set();
    this.dd = makeDeduper();
  }

  // items: what the broadcast or the stored list holds. Returns [{ index, row }] for the rows that were new, in the order to
  // apply them: each index is valid once the earlier ones are in.
  add(kind, items) {
    const fresh = [];
    const list = (items || []).filter((it) => it && Number.isFinite(it.t) && typeof it.text === 'string');
    // a batch is cleaned in time order, so the repeat remover sees the earlier piece first
    for (const it of [...list].sort((a, b) => a.t - b.t)) {
      const key = keyOf(kind, it);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      const isScreen = kind === 'screen';
      const text = isScreen ? it.text.trim() : cleanTranscript(it.text, [], this.dd).text;
      if (!text) continue; // cleaned away (a repeat, or the model thinking aloud); kept in `keys` so it is not retried
      const row = { key, kind: isScreen ? 'screen' : 'line', t: it.t, src: it.src || '', who: isScreen ? '' : whoOf(it, this.opts), text, presenter: isScreen ? String(it.presenter || '') : '' };
      let i = this.rows.length;
      while (i > 0 && this.rows[i - 1].t > row.t) i--;
      this.rows.splice(i, 0, row);
      fresh.push({ index: i, row });
    }
    return fresh;
  }

  get lastT() {
    return this.rows.length ? this.rows[this.rows.length - 1].t : 0;
  }
  lines() {
    return this.rows.filter((r) => r.kind === 'line');
  }
  wordCount() {
    return this.lines().reduce((a, r) => a + wordsOf(r.text).length, 0);
  }
}

// ---- page state --------------------------------------------------------------------------------------------------------
// Inputs: the last 'state' broadcast, the answer of the background's live-state call, and the stored meeting's META.
// What was stored wins over everything: a meeting with an end time is over.
export function reduceState({ id, broadcast = null, rec = null, meta = null, prev = null } = {}) {
  const startedAt = broadcast?.startedAt ?? (rec?.meetingId === id ? rec.startedAt : null) ?? meta?.startedAt ?? prev?.startedAt ?? null;
  if (meta?.endedAt) return { phase: 'ended', startedAt, endedAt: meta.endedAt };
  if (rec && rec.recording && rec.meetingId === id) return { phase: rec.paused ? 'paused' : 'recording', startedAt };
  if (broadcast) {
    if (broadcast.recording === false) return { phase: 'ended', startedAt };
    return { phase: broadcast.paused ? 'paused' : 'recording', startedAt };
  }
  // the background answered and this meeting is not what it records: it is over, even when no end time was stored
  if (rec && meta) return { phase: 'ended', startedAt };
  if (prev && prev.phase !== 'unknown') return { ...prev, startedAt };
  return { phase: 'unknown', startedAt };
}

export function chipText(state, now = Date.now()) {
  if (state.phase === 'recording') return `Recording · ${Number.isFinite(state.startedAt) ? fmtTime((now - state.startedAt) / 1000) : '--:--'}`;
  if (state.phase === 'paused') return 'Paused';
  if (state.phase === 'ended') return 'Ended';
  return 'Status unknown';
}

// ---- notes under the header -------------------------------------------------------------------------------------------------
const rough = (sec) => {
  if (sec < 90) return `${Math.max(5, Math.round(sec / 5) * 5)} seconds`;
  const m = Math.round(sec / 60);
  return `${m} minutes`;
};
export function latencyNote(settings = {}) {
  const { minSec, maxSec } = chunkSecs(settings);
  const text = `Text arrives in pieces of about ${rough((minSec + maxSec) / 2)}.`;
  const hint = settings.sttProvider === 'gemini' && settings.sttGeminiChunk !== 'short' ? 'For a faster live view choose short pieces in Settings → Recording (uses more of the free daily allowance).' : '';
  return { text, hint };
}

// ---- scrolling ---------------------------------------------------------------------------------------------------------------
// Follow new lines only while the reader is at the bottom; never pull someone away from what they scrolled up to read.
export const atBottom = ({ scrollTop, clientHeight, scrollHeight }, slack = FOLLOW_SLACK) => scrollHeight - (scrollTop + clientHeight) <= slack;

// ---- the provisional summary -------------------------------------------------------------------------------------------------
export const ENOUGH = 'Not enough has been said yet.';

// meeting: the stored record (title, startedAt, room); lines: the rows of THIS meeting. Nothing else goes in the prompt.
export function summaryPrompt({ meeting, rows, settings }) {
  const lines = (rows || []).filter((r) => r.kind === 'line');
  const words = lines.reduce((a, r) => a + wordsOf(r.text).length, 0);
  if (words < MIN_WORDS) return { ok: false, words, reason: ENOUGH };
  const languages = joinNames(languagesOf(settings));
  const segments = lines.map((r) => ({ t: r.t, src: r.src, text: r.text, ...(r.who && r.who !== 'Me' && r.who !== 'Others' && r.who !== 'Room' ? { spk: r.who } : {}) }));
  const m = { id: meeting?.id, title: meeting?.title || 'Meeting in progress', startedAt: meeting?.startedAt, segments };
  const ctx = { entries: parseDictionary(settings.dictionary), attendees: [], learned: (settings.learnedNames || []).slice(-40), room: !!meeting?.room };
  const note = 'This meeting is still going on. The transcript below is only what was said so far, and it stops where the meeting is now. Write the minutes of what was said so far; do not guess what comes next.';
  return { ok: true, words, system: structuredSystem(settings.momLanguage, { languages }), user: `${note}\n\n${structuredUser(m, settings, '', ctx)}` };
}

// "written at mm:ss": the recording clock while it runs, else the last line.
export const summaryAt = (state, lastT, now = Date.now()) => fmtTime(state.phase === 'recording' && Number.isFinite(state.startedAt) ? (now - state.startedAt) / 1000 : lastT);
export const provisionalLabel = (at) => `Provisional — written at ${at} from what was said so far. The final minutes are written when the meeting ends.`;
