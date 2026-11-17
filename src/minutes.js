// The minutes pipeline. gen(system, user, onText, opts) does one model call.
//   structured (default): ONE call returns a JSON document (src/structured.js); code validates it, guards it and renders
//     the Markdown; the structured items are returned too (meeting.items). Weak replies fall back to the classic way.
//   classic: extract every item window by window, write the minutes with that checklist, then audit the result against
//     the transcript. The structured items are read back from the Markdown, best effort.
//   organisation template: its own dedicated call (formal register); the items are read from its parsed result.
import {
  buildSystemPrompt,
  buildUserPrompt,
  formatTranscript,
  buildExtractPrompt,
  buildCheckPrompt,
  MERGE_SYSTEM,
  buildMergePrompt,
  EXTRACT_SYSTEM,
  CHECK_SYSTEM,
  splitWindows,
  parseItems,
  itemsToChecklist,
  guardOwners,
  sanitizeMinutes,
  buildTemplateSystemPrompt,
  buildTemplateUserPrompt,
  wordsOf,
} from './prompt.js';
import { buildFacts, parseDirectory, parseModelOutput, guardProse, knownParties, composeMarkdown, fmtDate, setOrg, getOrg } from './orgtemplate.js';
import { attendanceMarkdown } from './attendance.js';
import { isLocalBase } from './local.js';
import { languagesOf, joinNames } from './languages.js';
import { gapLabel, gapMinutes } from './coverage.js';
import { structuredSystem, structuredUser, structuredFixSystem, structuredFixUser, parseStructured, parseStructuredReply, guardStructured, assignIds, renderMinutes, itemsFromMarkdown, itemsFromTemplate, countsOf, withCarry } from './structured.js';
import { normalizeReview, parseReview } from './actions.js';
import { updatesSystem, updatesUser, parseUpdates, fillRoster, updatesMarkdown, insertUpdates, rosterOf } from './meetingtypes.js';

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

// Why the table cannot list invitees and absentees, in words for the minutes.
export function noInviteReason(meeting, settings) {
  if (settings.calendarLookup === false) return 'looking up who was invited is switched off in Settings';
  if (meeting.invitedError) return `the calendar lookup failed (${String(meeting.invitedError).slice(0, 120)})`;
  if (meeting.invitedNotFound) return 'no calendar event with this meeting\'s Meet link or title was found';
  if (!meeting.invitedChecked) return 'the calendar lookup has not run (email relay not set up, or the meeting has not ended)';
  return 'no calendar invite was found to compare with';
}

export const CUT_OFF_WARNING = "The model's answer was cut off, so the end of the meeting may be missing from these minutes. Press Rewrite minutes, or choose a model with a longer answer limit.";

// truncated: the minutes were made from a reply that stopped at the model's output limit.
export function coverageMarkdown({ pendingCount = 0, pendingSec = 0, errors = 0, gaps = [], truncated = false }) {
  const parts = [];
  if (pendingCount > 0) {
    parts.push(`**Coverage warning:** about ${Math.max(1, Math.round(pendingSec / 60))} min of audio (${pendingCount} piece${pendingCount > 1 ? 's' : ''}) could not be transcribed, so some points may be missing from these minutes.`);
  }
  if (gaps.length) {
    const shown = gaps.slice(0, 6).map(gapLabel).join(', ');
    parts.push(`${pendingCount > 0 ? 'Also, no' : '**Coverage warning:** no'} transcript was produced for ${shown}${gaps.length > 6 ? ` and ${gaps.length - 6} more` : ''} (about ${gapMinutes(gaps)} min in all). If people spoke then, those points may be missing from these minutes.`);
  }
  if (truncated) parts.push(`${parts.length ? '' : '**Coverage warning:** '}${CUT_OFF_WARNING}`);
  if (parts.length) return parts.join(' ');
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

// A transcript this long is the likely reason a one-call answer was cut off: it is then written the classic way, in windows.
export const LONG_WORDS = 3000;

const completenessSection = (points) => `## Added by the completeness check\n_These points were in the transcript but missing from the minutes above. Please review them._\n\n${points.map((m) => `- ${m}`).join('\n')}`;

// Missed points ("[12:40] Rahul to run the load test") the edited minutes still do not hold: none of the entries the edit
// added (not in `before`) is dated within 5 s of the point's time or shares most of the point's words.
export function stillMissing(missing, items, before = null) {
  const secs = (t) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null;
  };
  const LISTS = ['decisions', 'actions', 'risks', 'questions', 'next'];
  const key = (t) => wordsOf(t || '').join(' ');
  const textsOf = (it) => [...(it?.summary || []), ...(it?.topics || []).flatMap((t) => [t.title, ...(t.points || [])])];
  const had = new Set([...textsOf(before), ...LISTS.flatMap((k) => (before?.[k] || []).map((x) => x.text))].map(key));
  const added = LISTS.flatMap((k) => items?.[k] || []).filter((x) => !had.has(key(x.text)));
  const dated = added.map((x) => secs(x.at)).filter((x) => x != null);
  const texts = [...textsOf(items).filter((t) => !had.has(key(t))), ...added.map((x) => x.text)].map((t) => new Set(wordsOf(t || '')));
  return missing.filter((point) => {
    const at = secs((/^\[?((?:\d+:)?\d{1,2}:\d{2})/.exec(point) || [])[1]);
    if (at != null && dated.some((x) => Math.abs(x - at) <= 5)) return false;
    const words = [...new Set(wordsOf(point.replace(/^\[?[\d:]+\]?\s*/, '')))].filter((w) => w.length > 2);
    if (!words.length) return true;
    return !texts.some((t) => words.filter((w) => t.has(w)).length / words.length >= 0.6);
  });
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
  let thorough = settings.minutesMode !== 'quick' && words >= 400;
  const engine = settings.minutesEngine === 'classic' ? 'classic' : 'structured';
  const wantTemplate = settings.minutesFormat !== 'standard';
  const stats = { extractWindows: 0, extractFailed: 0, items: 0, missed: 0, calls: 0, engine };
  const carry = ctx.carry?.open?.length ? ctx.carry : null; // open action items of the previous meeting in the series
  const languages = joinNames(languagesOf(settings));
  // Did the reply the minutes are made from stop at the model's output limit? (The provider says so through onMeta.)
  let cutOff = false;
  const metaOf = (flag) => ({ onMeta: (m) => m?.truncated && (flag.cut = true) });

  let checklist = '';
  let extract = null;
  let extracted = false;
  // The item extraction. The structured engine reads the whole transcript in one call and skips it, except for local
  // models and very long transcripts (and the template format, which keeps its dedicated flow); the classic fallback runs it when needed.
  async function ensureExtract() {
    if (extracted || !thorough) return;
    extracted = true;
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
  if (thorough && (wantTemplate || engine === 'classic' || local || words > 24000)) await ensureExtract();

  const presence = { ...(ctx.voicePresence || {}), ...(meeting.presence || {}) };
  const clock = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  ctx = { ...ctx, presenceLine: ctx.presenceLine || Object.entries(presence).filter(([n, v]) => n && Array.isArray(v)).map(([n, v]) => `${n} ${clock(v[0])}–${clock(v[1])}`).join('; ') };
  const roster = rosterOf({ presence, attendees: ctx.attendees || [] });
  let mom = '';
  let tpl = null; // { facts, prose } when the template was written and parsed
  let wasEmpty = false;
  let items = null; // the structured minutes
  let review = null; // what the meeting said about the carried action items: [{ id, status, note }]
  let viaStructured = false;
  if (wantTemplate) {
    // Organisation template: code builds the header and attendee tables, the model writes only the language parts.
    setOrg(settings);
    const dir = parseDirectory(settings.peopleDirectory);
    const facts = buildFacts({ meeting, settings, dir, presence, entries: ctx.entries, notes });
    const known = knownParties({ facts, meeting, dir, transcript });
    onStatus('Writing the minutes in the official format…');
    stats.calls++;
    const people = [...new Set([...facts.known.people, ...(meeting.invited || []).map((p) => p.name).filter(Boolean)])];
    const tflag = {};
    const raw = sanitizeMinutes(
      await gen(
        buildTemplateSystemPrompt(settings.momLanguage, { languages, org: getOrg().name }),
        buildTemplateUserPrompt(meeting, settings, notes, { ...ctx, checklist }, { people, orgs: known.orgs, dateText: fmtDate(meeting.startedAt) }),
        onText,
        { temperature: TEMPERATURE.write, ...metaOf(tflag) }
      )
    );
    wasEmpty = !raw;
    const prose = raw ? parseModelOutput(raw) : null;
    if (prose) {
      if (tflag.cut) cutOff = true;
      tpl = { facts, prose: guardProse(prose, known) };
      mom = composeMarkdown(tpl);
      stats.engine = 'template';
      items = itemsFromTemplate(tpl.prose);
    } else if (raw) {
      stats.fellBack = true; // the reply did not fit the template: write the standard minutes instead
      onStatus('The reply did not fit the official format. Writing standard minutes instead…');
    }
  }

  const durationSec = meeting.endedAt ? (meeting.endedAt - meeting.startedAt) / 1000 : 0;
  const guardOpts = { transcript, attendees: roster, absent: ctx.absent || [], known: [settings.myName, ...(meeting.invited || []).map((p) => p.name)].filter(Boolean), entries: ctx.entries || [], learned: ctx.learned || [], durationSec };

  // The structured call: one JSON document for the whole transcript. null when the model failed or the reply is unusable;
  // { cut: true } when the reply was cut off and a long transcript is better written part by part.
  async function structuredWrite() {
    onStatus('Writing the minutes…');
    let raw;
    const flag = {};
    try {
      stats.calls++;
      raw = await gen(structuredSystem(settings.momLanguage, { languages }), structuredUser(meeting, settings, notes, { ...ctx, checklist, carry }), onText, { temperature: TEMPERATURE.write, json: true, ...metaOf(flag) });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return null;
    }
    const { items: parsed, truncated } = parseStructuredReply(raw);
    const cut = truncated || !!flag.cut;
    if (cut) stats.truncated = true;
    // a cut-off answer on a long meeting (the likely cause): not accepted, the classic way reads it window by window
    if (cut && words >= LONG_WORDS) return { cut: true };
    if (!parsed) return null;
    if (cut) cutOff = true; // short meeting: what came back whole is kept, with the warning
    const { previous, ...doc } = guardStructured(parsed, guardOpts);
    return { items: assignIds(doc, meeting.items), review: carry ? normalizeReview(previous, carry.open) : null };
  }
  const renderStructured = () => renderMinutes(items, { meeting, attendees: roster, evidence: true, carry, review: review || [] });

  if (!mom && !wasEmpty) {
    let done = null;
    let cutLong = false;
    if (engine === 'structured') done = await structuredWrite();
    if (done?.cut) {
      cutLong = true;
      done = null;
    }
    if (done) {
      ({ items, review } = done);
      viaStructured = true;
      mom = renderStructured();
    } else {
      if (cutLong) {
        // the item extraction reads a long meeting in windows, so nothing at the end is lost to the answer limit
        stats.fellBack = 'classic';
        stats.engine = 'classic';
        thorough = true;
        onStatus('The answer was cut off before the end of this long meeting. Writing the minutes the classic way, part by part…');
      } else if (engine === 'structured') {
        // a model that cannot produce JSON still gets its minutes, the classic way
        stats.fellBack = stats.fellBack || 'classic';
        stats.engine = 'classic';
        onStatus('The reply was not usable as structured minutes. Writing them the classic way…');
      } else if (!tpl) onStatus('Writing the minutes…');
      await ensureExtract();
      stats.calls++;
      const flag = {};
      mom = sanitizeMinutes(await gen(buildSystemPrompt(settings.momLanguage, { evidence: true, languages }), withCarry(buildUserPrompt(meeting, settings, notes, { ...ctx, checklist }), carry, 'classic'), onText, { temperature: TEMPERATURE.write, ...metaOf(flag) }));
      if (flag.cut) cutOff = true;
    }
  }
  if (!mom) throw new Error('The model returned an empty reply. Try again, or choose another model in Settings.');
  const format = tpl ? 'template' : 'standard';

  let completeness = '';
  if (thorough && words <= (local ? 6000 : 24000)) {
    onStatus('Checking nothing was left out…');
    try {
      stats.calls++;
      const out = await gen(CHECK_SYSTEM, buildCheckPrompt(transcript, mom), undefined, { temperature: TEMPERATURE.check });
      const missing = sanitizeMinutes(out).split(/\r?\n/).map((l) => l.replace(/^[-*\s]+/, '').trim()).filter((l) => /^\[?\d{1,2}:\d{2}/.test(l)); // only real findings: a timestamp first; chatter like "Nothing is missing" is dropped
      stats.missed = missing.length;
      if (missing.length) {
        completeness = completenessSection(missing);
        if (viaStructured) {
          // the same JSON comes back with the missing points added; it is accepted only when nothing was lost and something was gained
          let fixed = null;
          try {
            onStatus('Adding the points that were missed…');
            stats.calls++;
            const flag = {};
            const reply = parseStructuredReply(await gen(structuredFixSystem(settings.momLanguage, { languages }), structuredFixUser(items, missing), undefined, { temperature: TEMPERATURE.check, json: true, ...metaOf(flag) }));
            const p = reply.truncated || flag.cut ? null : reply.items; // a cut-off edit would lose the end of the minutes
            if (p) {
              const { previous: _p, ...doc } = guardStructured(p, guardOpts);
              const next = assignIds({ ...doc, title: doc.title || items.title, overview: doc.overview || items.overview }, items);
              const [a, b] = [countsOf(items), countsOf(next)];
              if (Object.keys(a).every((k) => b[k] >= a[k]) && Object.keys(a).some((k) => b[k] > a[k])) fixed = next;
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
          }
          if (fixed) {
            const before = items;
            items = fixed;
            mom = renderStructured();
            stats.merged = true;
            // the edit may have added only some of them: the rest are still listed for review
            const still = stillMissing(missing, fixed, before);
            stats.missedLeft = still.length;
            completeness = still.length ? completenessSection(still) : '';
            if (completeness) mom += `\n\n${completeness}`;
          } else mom += `\n\n${completeness}`;
        } else if (!tpl) {
          // fold the missing points into the right sections; if the model returns something that is not the full minutes, list them at the end instead
          let merged = '';
          try {
            onStatus('Adding the points that were missed…');
            stats.calls++;
            const flag = {};
            merged = sanitizeMinutes(await gen(MERGE_SYSTEM, buildMergePrompt(mom, missing), undefined, { temperature: TEMPERATURE.check, ...metaOf(flag) }));
            if (flag.cut) merged = ''; // a cut-off rewrite would lose the end of the minutes
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
          }
          // it must be the whole document, longer than before, and carry every missed point's timestamp (so a refusal or a summary is not accepted)
          const stamps = missing.map((m) => (m.match(/^\[?(\d{1,2}:\d{2})/) || [])[1]).filter(Boolean);
          if (merged && /^#/.test(merged) && merged.length >= mom.length * 0.9 && merged.length > mom.length && stamps.every((t) => merged.includes(t))) {
            mom = merged;
            stats.merged = true;
            completeness = '';
          } else mom += `\n\n${completeness}`;
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
    }
  }

  // Classic minutes only exist as Markdown: read the items back, and what the meeting said about the carried actions.
  if (!tpl && !viaStructured) {
    items = itemsFromMarkdown(mom);
    if (carry) review = parseReview(mom, carry.open);
  }
  if (items) items = assignIds(items, meeting.items);

  // Meeting type with an "Updates by person" table: one extra, focused call over the whole transcript.
  let updates = null;
  let updatesNote = '';
  const mt = ctx.meetingType;
  if (mt?.updates) {
    try {
      onStatus('Writing the updates by person…');
      stats.calls++;
      const raw = await gen(updatesSystem(mt.columns, settings.momLanguage), updatesUser({ meeting, roster: roster, transcript }), undefined, { temperature: TEMPERATURE.check });
      const rows = fillRoster(parseUpdates(raw, mt.columns), roster, mt.columns);
      if (rows.length) updates = { columns: mt.columns, rows };
      else updatesNote = 'The updates by person could not be read from the model reply. Press Rewrite minutes to try again.';
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      updatesNote = 'The updates by person could not be written. Press Rewrite minutes to try again.';
    }
  }

  const cov = coverageMarkdown({ ...coverage, truncated: cutOff });
  let how = 'a single pass';
  if (viaStructured) {
    if (stats.calls > 1) how = `${stats.calls} model calls (${[stats.items || stats.extractWindows ? 'item extraction' : '', 'structured writing', thorough ? 'completeness check' : ''].filter(Boolean).join(', ')}${stats.extractFailed ? `; ${stats.extractFailed} extraction part(s) failed` : ''})`;
  } else if (thorough || stats.fellBack === 'classic') {
    how = `${stats.calls} model calls (item extraction, writing, completeness check${stats.extractFailed ? `; ${stats.extractFailed} extraction part(s) failed` : ''})`;
  }
  const written = `_Written with ${how}._`;
  if (tpl) {
    // The attendee tables replace the Attendance section; warnings and the check go to a section that is hidden in print and mail.
    return { mom: composeMarkdown({ ...tpl, updates, review: [updatesNote, cov, written, completeness].filter(Boolean) }), stats, checklist, extract, format, items, review: null };
  }
  if (updates) mom = insertUpdates(mom, updatesMarkdown(updates.rows, updates.columns));
  const attendance = attendanceMarkdown({ invited: meeting.invited, presence, durationSec, entries: ctx.entries, myName: settings.myName, whyNoInvite: noInviteReason(meeting, settings) });
  const foot = [];
  if (attendance) foot.push(attendance);
  if (cov) foot.push(cov);
  if (updatesNote) foot.push(`**${updatesNote}**`);
  foot.push(written);
  return { mom: `${mom}\n\n---\n\n${foot.join('\n\n')}`, stats, checklist, extract, format, items, review };
}
