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
} from './prompt.js';
import { attendanceMarkdown } from './attendance.js';

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

export function coverageMarkdown({ pendingCount = 0, pendingSec = 0, errors = 0 }) {
  if (pendingCount > 0) {
    return `**Coverage warning:** about ${Math.max(1, Math.round(pendingSec / 60))} min of audio (${pendingCount} piece${pendingCount > 1 ? 's' : ''}) could not be transcribed, so some points may be missing from these minutes.`;
  }
  if (errors > 0) return `Note: ${errors} transcription problem${errors > 1 ? 's' : ''} occurred during the recording; the audio was retried and recovered where possible.`;
  return '';
}

// meeting: record; ctx: { entries, attendees, absent, captions, invited }
export async function writeMinutes({ meeting, settings, notes, ctx = {}, gen, onText = () => {}, onStatus = () => {}, coverage = {} }) {
  const lines = formatTranscript(meeting, settings.myName, ctx).split('\n').filter(Boolean);
  const transcript = lines.join('\n');
  const words = wordCount(transcript);
  const thorough = settings.minutesMode !== 'quick' && words >= 400;
  const stats = { extractWindows: 0, extractFailed: 0, items: 0, missed: 0, calls: 0 };

  let checklist = '';
  if (thorough) {
    const windows = splitWindows(lines);
    const items = [];
    for (let i = 0; i < windows.length; i++) {
      onStatus(`Reading the transcript carefully (part ${i + 1} of ${windows.length})…`);
      try {
        stats.calls++;
        const out = await gen(EXTRACT_SYSTEM, buildExtractPrompt(meeting, settings, windows[i].join('\n'), ctx));
        items.push(...parseItems(out));
        stats.extractWindows++;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        stats.extractFailed++;
      }
    }
    stats.items = items.length;
    checklist = itemsToChecklist(items);
  }

  onStatus('Writing the minutes…');
  stats.calls++;
  let mom = (await gen(buildSystemPrompt(settings.momLanguage, { evidence: true }), buildUserPrompt(meeting, settings, notes, { ...ctx, checklist }), onText)).trim();

  if (thorough && words <= 24000) {
    onStatus('Checking nothing was left out…');
    try {
      stats.calls++;
      const out = await gen(CHECK_SYSTEM, buildCheckPrompt(transcript, mom));
      const missing = out.split(/\r?\n/).map((l) => l.replace(/^[-*\s]+/, '').trim()).filter((l) => l && !/^NONE\b/i.test(l));
      stats.missed = missing.length;
      if (missing.length) {
        mom += `\n\n## Added by the completeness check\n_These points were in the transcript but missing from the minutes above. Please review them._\n\n${missing.map((m) => `- ${m}`).join('\n')}`;
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
    }
  }

  const durationSec = meeting.endedAt ? (meeting.endedAt - meeting.startedAt) / 1000 : 0;
  const attendance = attendanceMarkdown({ invited: meeting.invited, presence: meeting.presence, durationSec, entries: ctx.entries, myName: settings.myName });
  const cov = coverageMarkdown(coverage);
  const foot = [];
  if (attendance) foot.push(attendance);
  if (cov) foot.push(cov);
  foot.push(`_Written with ${thorough ? `${stats.calls} model calls (item extraction, writing, completeness check${stats.extractFailed ? `; ${stats.extractFailed} extraction part(s) failed` : ''})` : 'a single pass'}._`);
  return { mom: `${mom}\n\n---\n\n${foot.join('\n\n')}`, stats, checklist };
}
