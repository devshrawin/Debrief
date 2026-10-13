import { fmtTime } from './store.js';
import { applyDictionary, glossaryLine } from './dictionary.js';

export function buildSystemPrompt(language, { evidence = true } = {}) {
  return `You write Minutes of Meeting (MOM) from raw transcripts of online meetings held in Hindi, English, Malayalam, or a mix of them (Hinglish, Manglish).

About the transcript:
- It is machine speech-to-text. Expect misheard words, garbled names, repeated fragments, and Hindi or Malayalam written in their own script or in Latin script. Infer the intended meaning from context; do not reproduce transcription noise.
- Lines tagged ME come from the note-taker's own microphone. Lines tagged OTHERS are all remote participants mixed together, so you usually cannot tell which remote person spoke. Attribute statements to a named person only when the transcript itself makes it clear (someone is addressed by name, introduces themselves, or is assigned a task by name), or when a speaker timeline is provided below the transcript.
- If the note-taker's microphone picked up speaker audio, the same sentence may appear under both ME and OTHERS. Count it once.

Names:
- If a "Names" list or an attendee list is given, it is authoritative: write every name exactly as spelled there, even if the transcript spelled it differently (for example a common name that sounds similar). Never invent a surname.
- Only name someone as an action owner when the transcript or the attendee list supports it. If the named owner is listed as not present in the meeting, say so in the action row.

Completeness:
- Capture EVERY decision, action item, commitment, deadline, open question and risk that was mentioned, however briefly. When a checklist of extracted items is supplied, each item must end up in Decisions, Action Items or Open Questions (merge true duplicates only).
- Do not drop an item because it seems minor. Do not add anything the transcript does not support.

Write the MOM in ${language}. Keep names, product names, numbers, dates, and technical terms exactly as said. Record only what the transcript supports. When something is ambiguous, keep it and mark it "(unclear)" rather than guessing, and never invent owners or deadlines.

Output GitHub-flavored Markdown in this structure, leaving out any section that has no content except Action Items:

# <meeting title>
**Date:** … · **Duration:** … · **Participants (as identified):** …

## Summary
3–6 bullets covering the purpose and main outcomes.

## Discussion
One ### sub-heading per topic, with concise bullets for the key points, figures, and viewpoints raised.

## Decisions
Bulleted list of what was agreed${evidence ? ', each ending with the time it was said in brackets, e.g. [12:40]' : ''}.

## Action Items
${evidence ? '| # | Action | Owner | Due | Source |\n|---|--------|-------|-----|--------|\nIn Source put the timestamp and a quote of at most 12 words from the transcript, e.g. [12:40] "kal tak deploy kar denge". ' : '| # | Action | Owner | Due |\n|---|--------|-------|-----|\n'}Use "—" for an unknown owner or due date. If there are none, write "None recorded."

## Open Questions / Follow-ups

## Next Meeting
Only if a date, time, or agenda for the next meeting was mentioned.

Do not write an Attendance section or notes about the recording: they are added automatically. Output only the Markdown MOM, with no preamble.`;
}

// ctx: { entries (parsed dictionary), attendees: [names] } used to fix names in the text itself.
export function formatTranscript(meeting, myName, ctx = {}) {
  const me = myName ? `ME (${myName})` : 'ME';
  return [...meeting.segments]
    .sort((a, b) => a.t - b.t)
    .map((s) => `[${fmtTime(s.t)}] ${s.src === 'me' ? me : 'OTHERS'}: ${applyDictionary(s.text, ctx.entries, ctx.attendees)}`)
    .join('\n');
}

// "Who was talking when" read from Meet's live captions, collapsed to runs per speaker.
export function speakerTimeline(captions, ctx = {}) {
  if (!captions?.length) return '';
  const runs = [];
  for (const c of [...captions].sort((a, b) => a.t - b.t)) {
    const last = runs[runs.length - 1];
    const name = applyDictionary(c.name, ctx.entries, ctx.attendees);
    if (last && last.name === name && c.t - last.end < 20) {
      last.end = c.t;
      if (last.text.length < 160) last.text += ` ${c.text}`;
    } else runs.push({ name, start: c.t, end: c.t, text: c.text });
  }
  return runs.map((r) => `[${fmtTime(r.start)}–${fmtTime(r.end)}] ${r.name}: ${r.text.slice(0, 160)}`).join('\n');
}

function header(meeting, settings) {
  const start = new Date(meeting.startedAt);
  const durationMin = meeting.endedAt ? Math.round((meeting.endedAt - meeting.startedAt) / 60000) : null;
  return [
    `Meeting title: ${meeting.title || 'Untitled meeting'}`,
    `Date: ${start.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
    durationMin != null ? `Duration: ${durationMin} min` : null,
    settings.myName ? `Note-taker (ME): ${settings.myName}` : null,
  ].filter(Boolean);
}

// ctx: { entries, attendees, absent: [names], captions, checklist }
export function buildUserPrompt(meeting, settings, notes, ctx = {}) {
  const lines = header(meeting, settings);
  const names = glossaryLine(ctx.entries || [], ctx.attendees || []);
  if (names) lines.push('', `Names and terms (spell exactly like this): ${names}`);
  if (ctx.attendees?.length) lines.push(`Attendees in the meeting: ${ctx.attendees.join(', ')}`);
  if (ctx.absent?.length) lines.push(`Invited but NOT seen in the meeting: ${ctx.absent.join(', ')}`);
  if (notes?.trim()) lines.push('', 'Context from the note-taker (attendees, agenda, spellings):', notes.trim());
  const timeline = speakerTimeline(ctx.captions, ctx);
  lines.push('', '<transcript>', formatTranscript(meeting, settings.myName, ctx), '</transcript>');
  if (timeline) lines.push('', 'Speaker timeline from Meet live captions (who was talking when; the caption wording may be wrong, so use it only to attribute speakers):', '<speakers>', timeline, '</speakers>');
  if (ctx.checklist) lines.push('', 'Checklist of items extracted from the transcript. Every one must appear in the minutes:', '<checklist>', ctx.checklist, '</checklist>');
  return lines.join('\n');
}

// ---- multi-pass helpers -------------------------------------------------------------------

export const EXTRACT_SYSTEM = `You extract facts from one part of a meeting transcript (Hindi, English, Malayalam or a mix). The transcript is machine speech-to-text, so names and numbers may be garbled. If a Names list is given, use exactly those spellings.

List EVERY decision, action item, commitment, deadline, open question, risk, number or date that was stated, however briefly. One per line, in exactly this format:
TYPE | owner or - | due or - | [mm:ss] | short description | quote of at most 12 words
TYPE is one of ACTION, DECISION, QUESTION, RISK, FACT. Use "-" when owner or due is not stated; never guess an owner. If there is nothing, output NONE. Output only the lines.`;

export function buildExtractPrompt(meeting, settings, windowText, ctx = {}) {
  const lines = header(meeting, settings);
  const names = glossaryLine(ctx.entries || [], ctx.attendees || []);
  if (names) lines.push(`Names and terms (spell exactly like this): ${names}`);
  lines.push('', '<transcript>', windowText, '</transcript>');
  return lines.join('\n');
}

export const CHECK_SYSTEM = `You audit meeting minutes against the transcript they were written from. Find anything stated in the transcript that is MISSING from the minutes: decisions, action items (with owner or deadline), commitments, open questions, risks, important numbers or dates. Ignore small talk and anything already covered, even if worded differently.
Output one line per missing item as: [mm:ss] description | quote of at most 12 words. If nothing is missing, output exactly NONE. Output only those lines.`;

export function buildCheckPrompt(transcriptText, mom) {
  return ['<transcript>', transcriptText, '</transcript>', '', '<minutes>', mom, '</minutes>'].join('\n');
}

// Splits timestamped transcript lines into windows of roughly maxWords words, never mid-line.
export function splitWindows(lines, maxWords = 3200) {
  const windows = [];
  let cur = [];
  let words = 0;
  for (const line of lines) {
    const w = line.split(/\s+/).length;
    if (cur.length && words + w > maxWords) {
      windows.push(cur);
      cur = [cur[cur.length - 1]]; // one line of overlap so a thought on the boundary is not cut in two
      words = cur[0].split(/\s+/).length;
    }
    cur.push(line);
    words += w;
  }
  if (cur.length) windows.push(cur);
  return windows;
}

// Parses the extraction lines, tolerating models that wander off the format.
export function parseItems(text) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*\d.)\s]+/, '').trim();
    if (!line || /^NONE\b/i.test(line)) continue;
    const parts = line.split('|').map((p) => p.trim());
    const type = (parts[0] || '').toUpperCase();
    if (!['ACTION', 'DECISION', 'QUESTION', 'RISK', 'FACT'].includes(type) || parts.length < 5) continue;
    items.push({ type, owner: parts[1], due: parts[2], at: parts[3], text: parts[4], quote: parts[5] || '' });
  }
  return items;
}

export function itemsToChecklist(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.type}|${it.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${it.type} ${it.at} ${it.text}${it.owner && it.owner !== '-' ? ` (owner: ${it.owner})` : ''}${it.due && it.due !== '-' ? ` (due: ${it.due})` : ''}${it.quote ? ` "${it.quote}"` : ''}`);
  }
  return out.join('\n');
}

// ---- guards against model slips (small local models especially) --------------------------------

const wordsOf = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

// An extracted owner must be named in or next to the sentence the item came from. Models invent owners
// ("please send the timeline" becomes "owner: Priya"), so when the transcript does not back the name,
// the owner is dropped instead of trusted. If the sentence cannot be located the item is left as it is.
export function guardOwners(items, windowText) {
  const sentences = String(windowText).split(/(?<=[.!?।])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const plain = sentences.map((x) => wordsOf(x).join(' '));
  return items.map((it) => {
    if (!it.owner || it.owner === '-') return it;
    const probe = wordsOf(it.quote || it.text).slice(0, 5).join(' ');
    if (probe.split(' ').length < 3) return it;
    const at = plain.findIndex((p) => p.includes(probe));
    if (at < 0) return it;
    const first = wordsOf(it.owner)[0];
    // The same sentence, or a very short neighbour ("Amal?") that is just addressing someone.
    const short = (x) => (x && x.split(' ').length <= 5 ? x : '');
    const near = [short(plain[at - 1]), plain[at], short(plain[at + 1])].filter(Boolean).join(' ');
    return first && near.split(' ').includes(first) ? it : { ...it, owner: '-', ownerDropped: it.owner };
  });
}

// Removes leaked prompt markup and placeholders that weaker models copy into their answer.
export function sanitizeMinutes(md) {
  return String(md || '')
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .split('\n')
    .filter((l) => !/^\s*<\/?(checklist|transcript|speakers|minutes)>\s*$/i.test(l))
    .join('\n')
    .replace(/\s*\|?\s*"?quote_of_max_12_words"?/gi, '')
    .replace(/<\/?(checklist|transcript|speakers|minutes)>/gi, '')
    .trim();
}
