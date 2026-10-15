// The minutes pipeline: extract every item window by window, write the minutes with that checklist,
// then audit the result against the transcript. gen(system, user, onText) does one model call.
import {
  buildSystemPrompt,
  buildUserPrompt,
  formatTranscript,
  buildExtractPrompt,
  buildCheckPrompt,
  EXTRACT_SYSTEM,
  CHECK_SYSTEM,
  splitWindows,
  parseItems,
  itemsToChecklist,
  guardOwners,
  sanitizeMinutes,
  buildAmnexSystemPrompt,
  buildAmnexUserPrompt,
} from './prompt.js';
import { buildFacts, parseDirectory, parseModelOutput, guardProse, knownParties, composeMarkdown, fmtDate } from './amnex.js';
import { attendanceMarkdown } from './attendance.js';
import { isLocalBase } from './local.js';
import { languagesOf, joinNames } from './languages.js';

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

// Why the table cannot list invitees and absentees, in words for the minutes.
export function noInviteReason(meeting, settings) {
  if (settings.calendarLookup === false) return 'looking up who was invited is switched off in Settings';
  if (meeting.invitedError) return `the calendar lookup failed (${String(meeting.invitedError).slice(0, 120)})`;
  if (meeting.invitedNotFound) return 'no calendar event with this meeting\'s Meet link or title was found';
  if (!meeting.invitedChecked) return 'the calendar lookup has not run (email relay not set up, or the meeting has not ended)';
  return 'no calendar invite was found to compare with';
}

export function coverageMarkdown({ pendingCount = 0, pendingSec = 0, errors = 0 }) {
  if (pendingCount > 0) {
    return `**Coverage warning:** about ${Math.max(1, Math.round(pendingSec / 60))} min of audio (${pendingCount} piece${pendingCount > 1 ? 's' : ''}) could not be transcribed, so some points may be missing from these minutes.`;
  }
  if (errors > 0) return `Note: ${errors} transcription problem${errors > 1 ? 's' : ''} occurred during the recording; the audio was retried and recovered where possible.`;
  return '';
}

// meeting: record; ctx: { entries, attendees, absent, captions, invited }
// A short fingerprint of text, to tell whether the transcript changed since the items were extracted.
export function textKey(text) {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2 + c) | 0;
  }
  return `${text.length}.${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

// Temperatures: extraction and the check are made as repeatable as the model allows (0); the writing keeps a little
// freedom (0.2) so the prose reads naturally.
export const TEMPERATURE = { extract: 0, write: 0.2, check: 0 };

export async function writeMinutes({ meeting, settings, notes, ctx = {}, gen, onText = () => {}, onStatus = () => {}, coverage = {} }) {
  const lines = formatTranscript(meeting, settings.myName, ctx).split('\n').filter(Boolean);
  const transcript = lines.join('\n');
  const words = wordCount(transcript);
  // Small local models read less at a time: use smaller windows and skip the whole-transcript audit for long meetings.
  const local = settings.llmProvider === 'openai' && isLocalBase(settings.oaBase);
  const thorough = settings.minutesMode !== 'quick' && words >= 400;
  const stats = { extractWindows: 0, extractFailed: 0, items: 0, missed: 0, calls: 0 };

  let checklist = '';
  let extract = null;
  if (thorough) {
    const windows = splitWindows(lines, local ? 1500 : 3200);
    const items = [];
    // The same transcript gives the same list: items found once are reused when the minutes are written again,
    // so a rewrite cannot suddenly find 12 action items where the first run found 4. "Re-read" forces a fresh read.
    const key = textKey(`${local ? 'l' : 'c'}|${transcript}|${(ctx.entries || []).length}|${(ctx.attendees || []).join(',')}`);
    const cached = !ctx.reread && meeting.extract?.key === key && Array.isArray(meeting.extract.items) ? meeting.extract.items : null;
    if (cached) {
      items.push(...cached);
      stats.reused = true;
      stats.extractWindows = windows.length;
    }
    for (let i = 0; !cached && i < windows.length; i++) {
      onStatus(`Reading the transcript carefully (part ${i + 1} of ${windows.length})…`);
      try {
        stats.calls++;
        const out = await gen(EXTRACT_SYSTEM, buildExtractPrompt(meeting, settings, windows[i].join('\n'), ctx), undefined, { temperature: TEMPERATURE.extract });
        items.push(...guardOwners(parseItems(out), windows[i].join('\n')));
        stats.extractWindows++;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        stats.extractFailed++;
      }
    }
    stats.items = items.length;
    checklist = itemsToChecklist(items);
    // only a complete read is worth keeping: a read with failed parts would lock in the gaps
    if (!cached && !stats.extractFailed) extract = { key, items };
  }

  const presence = { ...(ctx.voicePresence || {}), ...(meeting.presence || {}) };
  let mom = '';
  let amnex = null; // { facts, prose } when the official format was written and parsed
  let wasEmpty = false;
  if (settings.minutesFormat !== 'standard') {
    // Official Amnex format: code builds the header and attendee tables, the model writes only the language parts.
    const dir = parseDirectory(settings.peopleDirectory);
    const facts = buildFacts({ meeting, settings, dir, presence, entries: ctx.entries, notes });
    const known = knownParties({ facts, meeting, dir, transcript });
    onStatus('Writing the minutes in the official format…');
    stats.calls++;
    const people = [...new Set([...facts.known.people, ...(meeting.invited || []).map((p) => p.name).filter(Boolean)])];
    const raw = sanitizeMinutes(
      await gen(
        buildAmnexSystemPrompt(settings.momLanguage, { languages: joinNames(languagesOf(settings)) }),
        buildAmnexUserPrompt(meeting, settings, notes, { ...ctx, checklist }, { people, orgs: known.orgs, dateText: fmtDate(meeting.startedAt) }),
        onText,
        { temperature: TEMPERATURE.write }
      )
    );
    wasEmpty = !raw;
    const prose = raw ? parseModelOutput(raw) : null;
    if (prose) {
      amnex = { facts, prose: guardProse(prose, known) };
      mom = composeMarkdown(amnex);
    } else if (raw) {
      stats.fellBack = true; // the reply did not fit the template: write the standard minutes instead
      onStatus('The reply did not fit the official format. Writing standard minutes instead…');
    }
  }
  if (!mom && !wasEmpty) {
    if (!amnex) onStatus('Writing the minutes…');
    stats.calls++;
    mom = sanitizeMinutes(await gen(buildSystemPrompt(settings.momLanguage, { evidence: true, languages: joinNames(languagesOf(settings)) }), buildUserPrompt(meeting, settings, notes, { ...ctx, checklist }), onText, { temperature: TEMPERATURE.write }));
  }
  if (!mom) throw new Error('The model returned an empty reply. Try again, or choose another model in Settings.');
  const format = amnex ? 'amnex' : 'standard';

  let completeness = '';
  if (thorough && words <= (local ? 6000 : 24000)) {
    onStatus('Checking nothing was left out…');
    try {
      stats.calls++;
      const out = await gen(CHECK_SYSTEM, buildCheckPrompt(transcript, mom), undefined, { temperature: TEMPERATURE.check });
      const missing = sanitizeMinutes(out).split(/\r?\n/).map((l) => l.replace(/^[-*\s]+/, '').trim()).filter((l) => /^\[?\d{1,2}:\d{2}/.test(l)); // only real findings: a timestamp first; chatter like "Nothing is missing" is dropped
      stats.missed = missing.length;
      if (missing.length) {
        completeness = `## Added by the completeness check\n_These points were in the transcript but missing from the minutes above. Please review them._\n\n${missing.map((m) => `- ${m}`).join('\n')}`;
        if (!amnex) mom += `\n\n${completeness}`;
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
    }
  }

  const cov = coverageMarkdown(coverage);
  const written = `_Written with ${thorough ? `${stats.calls} model calls (item extraction, writing, completeness check${stats.extractFailed ? `; ${stats.extractFailed} extraction part(s) failed` : ''})` : 'a single pass'}._`;
  if (amnex) {
    // The attendee tables replace the Attendance section; warnings and the check go to a section that is hidden in print and mail.
    return { mom: composeMarkdown({ ...amnex, review: [cov, written, completeness].filter(Boolean) }), stats, checklist, extract, format };
  }
  const durationSec = meeting.endedAt ? (meeting.endedAt - meeting.startedAt) / 1000 : 0;
  const attendance = attendanceMarkdown({ invited: meeting.invited, presence, durationSec, entries: ctx.entries, myName: settings.myName, whyNoInvite: noInviteReason(meeting, settings) });
  const foot = [];
  if (attendance) foot.push(attendance);
  if (cov) foot.push(cov);
  foot.push(written);
  return { mom: `${mom}\n\n---\n\n${foot.join('\n\n')}`, stats, checklist, extract, format };
}
