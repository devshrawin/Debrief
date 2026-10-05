import { fmtTime } from './store.js';

export function buildSystemPrompt(language) {
  return `You write Minutes of Meeting (MOM) from raw transcripts of online meetings held in Hindi, English, Malayalam, or a mix of them (Hinglish, Manglish).

About the transcript:
- It is machine speech-to-text. Expect misheard words, garbled names, repeated fragments, and Hindi or Malayalam written in their own script or in Latin script. Infer the intended meaning from context; do not reproduce transcription noise.
- Lines tagged ME come from the note-taker's own microphone. Lines tagged OTHERS are all remote participants mixed together, so you usually cannot tell which remote person spoke. Attribute statements to a named person only when the transcript itself makes it clear (someone is addressed by name, introduces themselves, or is assigned a task by name).
- If the note-taker's microphone picked up speaker audio, the same sentence may appear under both ME and OTHERS. Count it once.

Write the MOM in ${language}. Keep names, product names, numbers, dates, and technical terms exactly as said. Record only what the transcript supports. When something is ambiguous, keep it and mark it "(unclear)" rather than guessing, and never invent owners or deadlines.

Output GitHub-flavored Markdown in this structure, leaving out any section that has no content except Action Items:

# <meeting title>
**Date:** … · **Duration:** … · **Participants (as identified):** …

## Summary
3–6 bullets covering the purpose and main outcomes.

## Discussion
One ### sub-heading per topic, with concise bullets for the key points, figures, and viewpoints raised.

## Decisions
Bulleted list of what was agreed.

## Action Items
| # | Action | Owner | Due |
|---|--------|-------|-----|
Use "—" for an unknown owner or due date. If there are none, write "None recorded."

## Open Questions / Follow-ups

## Next Meeting
Only if a date, time, or agenda for the next meeting was mentioned.

Output only the Markdown MOM, with no preamble.`;
}

export function formatTranscript(meeting, myName) {
  const me = myName ? `ME (${myName})` : 'ME';
  return [...meeting.segments]
    .sort((a, b) => a.t - b.t)
    .map((s) => `[${fmtTime(s.t)}] ${s.src === 'me' ? me : 'OTHERS'}: ${s.text}`)
    .join('\n');
}

export function buildUserPrompt(meeting, settings, notes) {
  const start = new Date(meeting.startedAt);
  const durationMin = meeting.endedAt ? Math.round((meeting.endedAt - meeting.startedAt) / 60000) : null;
  const lines = [
    `Meeting title: ${meeting.title || 'Untitled meeting'}`,
    `Date: ${start.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
    durationMin != null ? `Duration: ${durationMin} min` : null,
    settings.myName ? `Note-taker (ME): ${settings.myName}` : null,
  ].filter(Boolean);
  if (notes?.trim()) lines.push('', 'Context from the note-taker (attendees, agenda, spellings):', notes.trim());
  lines.push('', '<transcript>', formatTranscript(meeting, settings.myName), '</transcript>');
  return lines.join('\n');
}
