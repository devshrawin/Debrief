// Writing the minutes and sending them are a JOB that belongs to the meeting, not to a page. The same code runs in the
// background (the offscreen document) so the minutes and the email happen even when no minutes tab is open, and in the
// minutes page itself only when no background runner can be reached. The page is a viewer: it shows the job's progress.
//
// Job state lives in meeting.job: { state, error, beat, held, countdownEnd }
//   queued -> transcribing-retry -> writing -> emailing -> done | failed
// "held" = the person touched the minutes page during the countdown, so nothing starts until they press Write minutes.

import { getMeeting, getMeetingMeta, saveMeeting, patchMeeting, updateMeetingMeta, appendMeeting, listMeetingMetas, getSettings, llmReady, mergeEmailNames, stampLoaded, withWireStamps } from './store.js';
import { parseDictionary } from './dictionary.js';
import { writeMinutes } from './minutes.js';
import { pickType } from './meetingtypes.js';
import { cleanLineNames, usedNames } from './linenames.js';
import { matchPeople, setEmailNames, learnEmailNames, personLabel } from './attendance.js';
import { labelTranscript, voicePresence } from './voice/match.js';
import { usableVoices } from './voice/learn.js';
import { generate as realGenerate, modelLabel, isRetryable } from './llm.js';
import { transcribe } from './stt.js';
import { listPending, deletePending } from './audiostore.js';
import { buildEmail, sendMail, mailReady, parseAddresses, recipientsFor, lookupInvitees } from './mailer.js';
import { formatTranscript } from './prompt.js';
import { renderMd } from './md.js';
import { attributeMixed } from './mixer.js';
import { ACTIVE, isActive, STALE_MS, COUNTDOWN_MS, stuckJobs } from './jobstate.js';
import { findGaps, mergeGaps } from './coverage.js';
import { previousInSeries, openActions, applyReview, allOpenActions, setActionStatus, keepStatuses } from './actions.js';
import { guardAutoShare, splitRecipients, shareWarning, heldStatus } from './guard.js';
import { runWebhook, validWebhook } from './webhook.js';

export { ACTIVE, isActive, STALE_MS, COUNTDOWN_MS, stuckJobs, shareWarning, keepStatuses };

// The offscreen document has no chrome.storage: there, the store calls are sent to the service worker (see useStore).
// listMeetingMetas / getMeetingMeta are only used for carrying actions: where they are missing or fail, there is no carry.
// updateMeetingMeta takes a function, which cannot travel by message: a store given without it has none (see writeAndStore).
let IO = { getMeeting, getMeetingMeta, saveMeeting, patchMeeting, updateMeetingMeta, appendMeeting, listMeetingMetas, getSettings, mergeEmailNames };
export function useStore(io) {
  const next = { ...IO, ...io };
  if (io.patchMeeting && !io.updateMeetingMeta) next.updateMeetingMeta = null;
  // A copy that came by message has lost the hidden marks saveMeeting uses to see what this side changed (see
  // meetingstore.js). They are a function of the content, so they are put back on arrival and sent along on the way back.
  if (io.getMeeting) next.getMeeting = async (id) => stampLoaded(await io.getMeeting(id));
  if (io.saveMeeting) next.saveMeeting = (m) => io.saveMeeting(withWireStamps(m));
  // Appending where only get and save were given: read, push, save; the save writes only the new items (and no META).
  // The offscreen document should be given the service worker's appendMeeting, which sends just the items.
  if (io.saveMeeting && !io.appendMeeting)
    next.appendMeeting = async (id, list, items) => {
      const m = await next.getMeeting(id);
      if (!m) return false;
      if (Array.isArray(m[list])) m[list].push(...items); // the same array keeps its mark, so the save appends just these
      else m[list] = [...items];
      await next.saveMeeting(m);
      return true;
    };
  IO = next;
}

export const wantTranscript = (meeting, settings, shared) => (shared ? !!meeting.transcriptShare : meeting.transcriptMine ?? !!settings.emailTranscript);

// ---- who is who: shared by the page and the runner ----
export function labeledLinesFor(meeting, settings, forDisplay = false, cache = new Map()) {
  // Prompts and minutes only use voices that are named or trusted; the transcript view also shows the still-unnamed ones
  // ("Unnamed voice 2") so the user can see who said what and name them by reading.
  const people = forDisplay ? (settings.voices || []) : usableVoices(settings.voices);
  if (!settings.voiceOn || !meeting?.voiceSegs?.length || !people.length) return null;
  const key = `${forDisplay ? 'd' : 'n'}${meeting.room ? 'r' : ''}|${meeting.voiceSegs.length}|${meeting.segments.length}|${(meeting.captions || []).length}|${people.map((v) => `${v.id}${v.windows?.length}`).join(',')}`;
  if (!cache.has(key)) {
    if (cache.size > 8) cache.clear();
    cache.set(key, labelTranscript(meeting, people, { captions: meeting.captions, myName: settings.myName, room: !!meeting.room }));
  }
  return cache.get(key);
}

export function nameCtxFor(meeting, settings, cache) {
  const labeled = labeledLinesFor(meeting, settings, false, cache);
  return {
    entries: parseDictionary(settings.dictionary),
    // the names the user put on single lines count as people in the meeting (so they can own actions and get a row in updates)
    attendees: [...new Set([...(meeting?.attendees || []).filter(Boolean), ...usedNames(meeting?.lineNames)])],
    lineNames: cleanLineNames(meeting?.lineNames),
    learned: (settings.learnedNames || []).slice(-40),
    labeled,
    room: !!meeting.room,
    voicePresence: labeled ? voicePresence(labeled) : null,
  };
}

// Who was invited, from the calendar through the relay. Quiet if it is not set up or not permitted yet.
export async function ensureInvited(meeting, settings, patch) {
  if (meeting.invitedChecked || !settings.calendarLookup || !mailReady(settings) || !meeting.endedAt) return;
  try {
    const guests = await lookupInvitees(meeting, settings);
    await patch({ ...(guests ? { invited: [...guests], invitedHow: guests.how, invitedEvent: guests.event, invitedError: null } : { invitedNotFound: true }), invitedChecked: true });
  } catch (e) {
    await patch({ invitedError: e.message });
  }
}

// Calendar addresses with no name are matched to the people seen in the call; every clear match is remembered, so the next
// meeting (and this one's tables) shows "Name (address)" instead of a bare address.
export async function rememberEmailNames(meeting, settings, cache) {
  if (!meeting.invited?.length) return;
  try {
    const seen = { ...(nameCtxFor(meeting, settings, cache).voicePresence || {}), ...(meeting.presence || {}) };
    if (!Object.keys(seen).length) return;
    const found = learnEmailNames(matchPeople(meeting.invited, seen, { entries: parseDictionary(settings.dictionary), myName: settings.myName }).rows);
    if (!Object.keys(found).length) return;
    setEmailNames(await IO.mergeEmailNames(found));
  } catch {}
}

// Pre-fill the attendee list: who was actually seen (matched to calendar names), else who was invited.
export function ensureAttendees(meeting, settings, cache) {
  if (meeting.attendees?.length) return;
  const entries = parseDictionary(settings.dictionary);
  const seen = { ...(nameCtxFor(meeting, settings, cache).voicePresence || {}), ...(meeting.presence || {}) };
  const presence = Object.entries(seen).map(([name]) => (/^you$/i.test(name) && settings.myName ? settings.myName : name));
  let names = [];
  if (presence.length) {
    const m = matchPeople(meeting.invited, seen, { entries, myName: settings.myName });
    names = [...m.rows.filter((r) => r.present).map((r) => r.present.name || r.name), ...m.uninvited.map((p) => p.name)];
  } else if (meeting.invited?.length) {
    names = meeting.invited.filter((p) => p.status !== 'no').map((p) => personLabel(p));
  }
  if (names.length) meeting.attendees = [...new Set(names)];
}

// Re-transcribes audio chunks that failed during the meeting. Returns how many are still failing.
export async function retryPendingAudio({ id, meeting, settings, onProgress = () => {}, transcribeFn = transcribe }) {
  let pending = await listPending(id);
  let lastError = null;
  let done = 0;
  for (const p of pending) {
    onProgress(done, pending.length);
    try {
      const text = await transcribeFn(p.wav, settings);
      const segs = text ? (p.tl ? attributeMixed(text, p.t, p.tl) : [{ t: p.t, src: p.src, text }]).map((seg) => ({ ...seg, recovered: true, c: p.t, dur: Math.round(((p.wav.size - 44) / 32000) * 10) / 10 })) : [];
      // stored first, then the piece of audio is deleted: a crash in between re-transcribes it rather than losing it
      if (segs.length) await IO.appendMeeting(id, 'segments', segs);
      // the caller's copy gets the same lines; its array keeps its mark, so a later save of it does not add them twice
      meeting.segments.push(...segs);
      await deletePending(p.id);
      done++;
    } catch (e) {
      lastError = e.message;
    }
  }
  pending = await listPending(id);
  return { left: pending.length, lastError, pending, done };
}

// Emails the minutes to the person themselves. The automatic send happens at most once: a lock per meeting, a check of
// emailedAt inside it, and a "sending" mark written before the request leaves (so a crash in between never means a second email).
const GONE = { status: 'This meeting was deleted.', deleted: true };

export async function emailMinutes({ meeting, settings, auto, patch, getLatest, ctxFor, notify = () => {}, note = '' }) {
  if (!meeting.mom?.trim()) return { status: 'No minutes to email yet.' };
  if (!mailReady(settings)) return { status: 'Email is not set up. Add the Apps Script URL in Settings.' };
  const run = async () => {
    if (auto) {
      const latest = await getLatest();
      if (!latest) return GONE; // deleted while the minutes were written: nothing is sent
      if (latest.emailedAt) {
        Object.assign(meeting, { emailedAt: latest.emailedAt, emailedTo: latest.emailedTo });
        return { status: `Emailed to ${latest.emailedTo || 'you'} ✓`, sent: false };
      }
      if (latest.emailSending) return { status: 'The email may already have been sent. Check your inbox; press Email to send it again.', unsure: true };
      if ((await patch({ emailSending: Date.now() })) === null) return GONE;
    }
    const withTr = wantTranscript(meeting, settings, false);
    const mail = buildEmail(meeting, { ...settings, emailTranscript: withTr }, renderMd, withTr ? formatTranscript(meeting, settings.myName, ctxFor()) : '');
    const r = await sendMail(mail, settings);
    await patch({ emailedAt: Date.now(), emailedTo: r.to, emailSending: null });
    notify({ id: `debrief-mail-${meeting.id}`, title: 'Debrief: minutes emailed', message: `The minutes were sent.${note ? ` ${note}` : ''}` });
    return { status: `Emailed to ${r.to} ✓`, sent: true, to: r.to };
  };
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request(`debrief-email-${meeting.id}`, run) : await run();
  } catch (e) {
    if (auto) await patch({ emailSending: null }).catch(() => {});
    return { status: `Email failed: ${e.message}`, failed: true };
  }
}

// Sends the minutes to other people (cc / bcc / to). `list` is the addresses, `how` is to | cc | bcc.
export async function shareMinutes({ meeting, settings, list, how, patch, ctxFor }) {
  if (!meeting.mom?.trim()) return { status: 'No minutes to share yet.' };
  if (!mailReady(settings)) return { status: 'Email is not set up. Add the Apps Script URL in Settings.' };
  if (!list.length) return { status: '' };
  const withTr = wantTranscript(meeting, settings, true);
  const mail = buildEmail(meeting, { ...settings, emailTranscript: withTr }, renderMd, withTr ? formatTranscript(meeting, settings.myName, ctxFor()) : '');
  const r = await sendMail(mail, settings, { to: how === 'to' ? list.join(',') : '', cc: how === 'cc' ? list.join(',') : '', bcc: how === 'bcc' ? list.join(',') : '' });
  const sent = [...(r.to && how === 'to' ? String(r.to).split(',') : []), ...(r.cc || []), ...(r.bcc || [])];
  // addresses that were held back and are now sent no longer show as held
  const asked = new Set(list.map((a) => a.toLowerCase()));
  const stillHeld = (meeting.shareHeld || []).filter((a) => !asked.has(String(a).toLowerCase()));
  await patch({ sharedAt: Date.now(), sharedTo: sent, shareTo: list, ...(meeting.shareHeld?.length ? { shareHeld: stillHeld, shareStatus: stillHeld.length ? heldStatus(stillHeld) : '' } : {}) });
  // manual sharing is never blocked: the page asks first (shareWarning) and shows these; with the guard off nothing is flagged
  const external = settings.shareExternalGuard === false ? [] : splitRecipients(list, settings).external;
  return {
    sent,
    external,
    transcriptToExternal: !!external.length && withTr,
    skipped: r.skipped || [],
    status: r.skipped?.length
      ? `Sent to ${sent.join(', ') || 'nobody'}. Not allowed by your script: ${r.skipped.join(', ')}. Add them under Settings → Email → Sharing, copy the updated script and deploy a new version.`
      : `Shared with ${sent.join(', ')} ✓`,
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    });
  });

// One generate call with retry-on-rate-limit.
// onMeta hears { truncated: true } from the provider (see llm.js). A stopped job makes no further call.
export async function generateWithRetry({ generate = realGenerate, settings, system, user, signal, onText, onMeta, temperature, json, onRetry = () => {}, wait = [5, 15, 30] }) {
  for (let i = 0; ; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    try {
      return await generate({ settings, system, user, signal, onText: onText || (() => {}), temperature, ...(json ? { json: true } : {}), ...(onMeta ? { onMeta } : {}) });
    } catch (e) {
      if (i >= 3 || !isRetryable(e)) throw e;
      onRetry(i + 1, e, wait[i]);
      await sleep(wait[i] * 1000, signal);
    }
  }
}

// Stretches with no transcript: the ones found while recording plus the ones the finished transcript shows.
export const transcriptGaps = (meeting) => mergeGaps(meeting.gaps || [], findGaps(meeting.segments || [], [...(meeting.pauses || []), ...(meeting.silences || []).map((s) => ({ from: s.t, to: s.t + s.dur }))]));

// Fields writeMinutes may return besides the text that are stored on the meeting (META) with the minutes.
export const SAVED_WITH_MINUTES = ['extract', 'items'];

// ---- carrying open actions into the next meeting of a series ----
const dateOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '');

// Best effort: anything missing or failing here means "no carry", never a failed job.
// A rewrite of the same minutes still lists the actions this meeting closed earlier (doneBy), so its table does not shrink.
async function prepareCarry(meeting, settings, io) {
  if (settings.actionCarry === false || typeof io.listMeetingMetas !== 'function') return null;
  const typeOf = (m) => pickType(settings.meetingTypes, m);
  const metas = await io.listMeetingMetas({ counts: [] });
  const prev = previousInSeries(meeting, metas, typeOf);
  if (!prev) return null;
  const open = (prev.items?.actions || []).filter((a) => a && (a.status !== 'done' || a.doneBy === meeting.id)).map(({ doneAt: _d, ...a }) => ({ ...a, status: 'open' }));
  if (!open.length) return null;
  return { prev, carry: { prevTitle: prev.title || '', prevDate: dateOf(prev.startedAt), open } };
}

// What the new minutes said about the carried actions is written onto the previous meeting: reported done -> done.
// Only ever towards done, and only for ids that were carried: 'open' or 'not mentioned' never reopens anything.
async function applyCarry(meeting, prep, review, io) {
  const ids = new Set(prep.carry.open.map((a) => a.id));
  const done = (review || []).filter((r) => ids.has(r.id));
  if (!done.length) return;
  let fresh = prep.prev;
  try {
    fresh = (await io.getMeetingMeta?.(prep.prev.id, { counts: [] })) || prep.prev; // the person may have changed it meanwhile
  } catch {}
  const before = fresh.items?.actions || [];
  const next = applyReview(fresh.items, done);
  const was = new Map(before.map((a) => [a.id, a.status]));
  next.actions = next.actions.map((a) => (a.status === 'done' && was.get(a.id) !== 'done' ? { ...a, doneBy: meeting.id } : a));
  if (next.actions.some((a, i) => a.status !== before[i]?.status)) await io.patchMeeting(prep.prev.id, { items: next });
}

// Every open action of every meeting, for a list that spans meetings. [] when the store cannot list them.
export async function openActionsAcrossMeetings(opts) {
  const metas = await IO.listMeetingMetas({ counts: [] });
  return allOpenActions(metas, opts);
}

// Marks one action done (or open again). Only the previous meeting's META changes.
export async function setActionDone(meetingId, actionId, done) {
  const m = await (IO.getMeetingMeta ? IO.getMeetingMeta(meetingId, { counts: [] }) : IO.getMeeting(meetingId));
  if (!m?.items?.actions?.some((a) => a.id === actionId)) return false;
  const next = setActionStatus(m.items, actionId, done ? 'done' : 'open');
  if (!done) next.actions = next.actions.map((a) => { if (a.id !== actionId) return a; const { doneBy: _b, ...rest } = a; return rest; }); // a person reopening it: no longer "closed by a meeting"
  await IO.patchMeeting(meetingId, { items: next });
  return true;
}

// The minutes are stored with the action statuses as they are NOW: merged and written as one META update where the store
// can do that (the service worker, a page; io.saveMinutes: the same done by the service worker for the offscreen document),
// else from a fresh read just before the patch. false when the meeting no longer exists (nothing is written or re-created).
async function storeMinutes(id, meeting, fields, patch, io) {
  if (typeof io.saveMinutes === 'function') {
    const r = await io.saveMinutes(id, fields);
    if (r === null) return false;
    Object.assign(meeting, fields, r?.items ? { items: r.items } : {});
    return true;
  }
  if (typeof io.updateMeetingMeta === 'function') {
    let merged = fields;
    const r = await io.updateMeetingMeta(id, (m) => {
      merged = fields.items ? { ...fields, items: keepStatuses(fields.items, m.items) } : fields;
      Object.assign(m, merged);
    });
    if (r === null) return false;
    Object.assign(meeting, merged);
    return true;
  }
  if (fields.items) {
    try {
      const cur = await (io.getMeetingMeta ? io.getMeetingMeta(id, { counts: [] }) : io.getMeeting(id));
      if (cur === null) return false;
      fields = { ...fields, items: keepStatuses(fields.items, cur?.items) };
    } catch {}
  }
  return (await patch(fields)) !== null;
}

// The whole write: the model calls, saving the minutes, the pending-audio count for the coverage note.
// `ui` has onStatus(text) and onText(delta). Returns { text, stats }.
export async function writeAndStore({ id, meeting, settings, reread = false, signal, ui, patch, cache, generate, io }) {
  io = { ...IO, ...io };
  const pending = await listPending(id);
  const ctx = nameCtxFor(meeting, settings, cache);
  const absent = matchPeople(meeting.invited, { ...(ctx.voicePresence || {}), ...(meeting.presence || {}) }, { entries: ctx.entries, myName: settings.myName }).rows.filter((r) => !r.present).map((r) => r.name); // names only: no addresses go to the model
  const meetingType = pickType(settings.meetingTypes, meeting);
  let prep = null;
  try {
    prep = await prepareCarry(meeting, settings, io);
  } catch (e) {
    await io.appendMeeting?.(id, 'debug', [`carrying actions skipped: ${e?.message || e}`]).catch(() => {});
  }
  const written = await writeMinutes({
    meeting,
    settings: { ...settings, minutesFormat: meeting.format || settings.minutesFormat },
    notes: meeting.notes,
    ctx: { ...ctx, absent, captions: meeting.captions, reread, meetingType, extraInstructions: meetingType?.extra || '', ...(prep ? { carry: prep.carry } : {}) },
    gen: async (system, user, onText, opts) => {
      await ui.ready?.(); // the status just written may have found the meeting deleted: then no call is made
      return generateWithRetry({
        generate, settings, system, user, signal, onText: onText && !opts?.json && ui.onText, onMeta: opts?.onMeta, temperature: opts?.temperature, json: !!opts?.json,
        onRetry: (n, e, wait) => ui.onStatus(`Attempt ${n} failed (${e.message.slice(0, 80)}). Retrying in ${wait} s…`, { keep: true }),
      });
    },
    onText: () => {},
    onStatus: (t) => ui.onStatus(t),
    coverage: { pendingCount: pending.length, pendingSec: pending.reduce((a, p) => a + (p.wav.size - 44) / 32000, 0), errors: (meeting.errors || []).length, gaps: transcriptGaps(meeting) },
  });
  const { mom: text, stats } = written;
  // whatever else writeMinutes returns to keep with the minutes (the extracted facts, structured items) is saved with them;
  // only these names, so nothing unexpected (and never a transcript list) is written by accident
  const keep = Object.fromEntries(SAVED_WITH_MINUTES.filter((k) => written[k] !== undefined && written[k] !== null).map((k) => [k, written[k]]));
  const carriedFrom = prep ? { carriedFrom: { id: prep.prev.id, title: prep.prev.title || '', at: prep.prev.startedAt } } : {};
  const fields = { mom: text, editedAt: null, model: modelLabel(settings), notes: meeting.notes, attendees: meeting.attendees, ...keep, ...carriedFrom };
  if (!(await storeMinutes(id, meeting, fields, patch, io))) return { text, stats, deleted: true }; // deleted meanwhile: the earlier meeting is left alone too
  if (prep && written.review?.length) {
    try {
      await applyCarry(meeting, prep, written.review, io);
    } catch (e) {
      await io.appendMeeting?.(id, 'debug', [`updating the earlier meeting's actions failed: ${e?.message || e}`]).catch(() => {});
    }
  }
  return { text, stats };
}

// ---- the runner ----
// deps: { getSettings, getMeeting, saveMeeting, emit(msg), notify(n), onIdle(), generate, transcribeFn, now, countdownMs, beatMs }
export function createJobRunner(deps = {}) {
  const d = {
    getSettings: () => IO.getSettings(), getMeeting: (i) => IO.getMeeting(i), saveMeeting: (m) => IO.saveMeeting(m), patchMeeting: (i, f) => IO.patchMeeting(i, f), emit: () => {}, notify: () => {}, onIdle: () => {}, generate: realGenerate, transcribeFn: transcribe,
    now: () => Date.now(), countdownMs: COUNTDOWN_MS, beatMs: 5000, ...deps,
  };
  // whoever is watching (the minutes page) may be gone: that must never stop the job
  const emit = (m) => {
    try {
      d.emit(m);
    } catch {}
  };
  const running = new Map(); // meeting id -> { ctl, held, release }

  async function pipeline(id, job, { force, reread, resume }) {
    let chain = Promise.resolve();
    // The meeting was deleted while the job ran (a patch finds no record): the job stops where it is. No model call, email,
    // share or webhook follows, and nothing is written (a patch never re-creates a record).
    let gone = false;
    const lost = () => {
      gone = true;
      job.ctl.abort();
    };
    const patch = (fields) => {
      // a small update of just these fields (the heartbeat and the status are written every few seconds)
      const run = chain.then(async () => {
        if (gone) return null;
        if (meeting) Object.assign(meeting, fields);
        const r = await d.patchMeeting(id, fields);
        if (r === null) lost();
        return r;
      });
      chain = run.catch(() => {});
      return run;
    };
    const exists = async () => !gone && (await patch({})) !== null;
    const cache = new Map();
    // what writeAndStore stores the minutes with; a test's own patchMeeting comes without the store's updateMeetingMeta
    const storeIo = deps.patchMeeting ? { patchMeeting: d.patchMeeting, getMeeting: d.getMeeting, getMeetingMeta: deps.getMeetingMeta, updateMeetingMeta: deps.updateMeetingMeta || null } : { patchMeeting: d.patchMeeting, getMeeting: d.getMeeting };
    let meeting = await d.getMeeting(id);
    if (!meeting) return;
    const settings = await d.getSettings();
    // a job that died while emailing already has its minutes: go straight on to the email instead of writing them again
    const skipWrite = !!resume && meeting.job?.state === 'emailing' && !!meeting.mom?.trim();
    const setJob = (fields) => {
      const next = { ...(meeting.job || {}), ...fields, beat: d.now() };
      emit({ type: 'job-progress', id, job: next });
      return patch({ job: next });
    };
    const beat = setInterval(() => meeting.job && isActive(meeting) && patch({ job: { ...meeting.job, beat: d.now() } }).catch(() => {}), d.beatMs);
    let hook = null; // the webhook runs beside the email; its outcome is written when it is over
    let buf = '';
    let lastEmit = 0;
    const ui = {
      ready: () => chain,
      onStatus: (t, o) => {
        if (!o?.keep) buf = '';
        emit({ type: 'job-progress', id, status: t, keep: !!o?.keep });
        // also on the meeting, so a page that opens later (or missed the message) shows the same stage
        setJob({ status: t }).catch(() => {});
      },
      onText: (delta) => {
        buf += delta;
        if (d.now() - lastEmit > 250) {
          lastEmit = d.now();
          emit({ type: 'job-progress', id, text: buf });
        }
      },
    };
    try {
      await setJob({ state: 'queued', error: null, held: false, countdownEnd: null, aborted: false });
      if (!llmReady(settings)) return await setJob({ state: 'failed', error: 'Set up an LLM in Settings first.' });
      if (!meeting.segments.length && !(await listPending(id)).length) return await setJob({ state: 'failed', error: 'Nothing to summarise: the transcript is empty.' });

      // who is who, so the tables and the attendee list are right
      await ensureInvited(meeting, settings, patch);
      await rememberEmailNames(meeting, settings, cache);
      if (!meeting.attendees?.length) {
        ensureAttendees(meeting, settings, cache);
        if (meeting.attendees?.length) await patch({ attendees: meeting.attendees });
      }

      // audio that failed during the meeting is transcribed first, so nothing is missing (a rewrite leaves it: that has its own button)
      if (!meeting.mom && (await listPending(id)).length) {
        await setJob({ state: 'transcribing-retry' });
        await retryPendingAudio({ id, meeting, settings, transcribeFn: d.transcribeFn });
      }
      if (!meeting.segments.length) return await setJob({ state: 'failed', error: 'Nothing to summarise: the transcript is empty.' });

      // the 10 s "before the minutes are written" countdown; touching the minutes page holds it
      if (!force && !meeting.decided && !meeting.mom) {
        if (job.held) return await setJob({ state: 'queued', held: true, countdownEnd: null });
        await setJob({ state: 'queued', countdownEnd: d.now() + d.countdownMs });
        await new Promise((resolve) => {
          const t = setTimeout(resolve, d.countdownMs);
          job.release = () => (clearTimeout(t), resolve());
        });
        job.release = null;
        if (job.held) return await setJob({ state: 'queued', held: true, countdownEnd: null });
      }

      if ((await patch({ decided: true })) === null) return;
      let result = { stats: meeting.job?.stats };
      if (!skipWrite) {
        await setJob({ state: 'writing', status: null, countdownEnd: null, held: false });
        try {
          result = await writeAndStore({ id, meeting, settings, reread, signal: job.ctl.signal, ui, patch, cache, generate: d.generate, io: storeIo });
        } catch (e) {
          if (gone) return;
          const stopped = job.ctl.signal.aborted;
          return await setJob({ state: 'failed', error: stopped ? 'Stopped.' : e.message, aborted: stopped });
        }
        if (result.deleted) lost();
        if (gone || !(await exists())) return;
        // first write and rewrites alike (not a resume after the email): a failing webhook never fails the job
        if (validWebhook(settings.webhookUrl)) hook = runWebhook(meeting, settings, patch, d.webhook);
      }
      if (gone || !(await exists())) return;

      // first time only: regenerating or editing never re-sends by itself
      if (settings.emailAuto && mailReady(settings) && !meeting.emailedAt && meeting.endedAt) {
        await setJob({ state: 'emailing' });
        // outsiders are held back from automatic sharing (counts only in the notification: it can show on a shared screen)
        const auto = settings.shareMode === 'auto' && !meeting.sharedAt;
        const shareList = auto ? parseAddresses((meeting.shareTo || recipientsFor(meeting, settings).list).join(',')) : [];
        const plan = guardAutoShare(shareList, settings);
        const note = plan.held.length ? `${plan.reason.charAt(0).toUpperCase()}${plan.reason.slice(1)} were not sent a copy automatically.` : '';
        const r = await emailMinutes({ meeting, settings, auto: true, patch, getLatest: () => d.getMeeting(id), ctxFor: () => nameCtxFor(meeting, settings, cache), notify: d.notify, note });
        if (r.deleted || gone) return lost();
        if (r.failed || r.unsure) await setJob({ state: 'failed', error: r.status, stats: result.stats });
        else {
          if (r.sent && auto) {
            if (plan.held.length) await patch({ shareHeld: plan.held, shareStatus: heldStatus(plan.held) }).catch(() => {});
            if (plan.send.length && !gone && (await exists())) await shareMinutes({ meeting, settings, list: plan.send, how: settings.shareHow || 'to', patch, ctxFor: () => nameCtxFor(meeting, settings, cache) }).catch(() => {});
          }
          await setJob({ state: 'done', error: null, stats: result.stats });
        }
      } else await setJob({ state: 'done', error: null, stats: result.stats });
    } catch (e) {
      if (!gone) await setJob({ state: 'failed', error: e.message }).catch(() => {});
    } finally {
      clearInterval(beat);
      if (hook) await hook; // never rejects
      await chain;
      emit({ type: 'job-progress', id, job: meeting.job, finished: true });
    }
  }

  // Starts a job for a meeting, unless one is already running for it (opening the page twice is one job).
  // force: skip the countdown (the person pressed Write minutes, or a job is being resumed).
  function run(id, { force = false, reread = false, resume = false } = {}) {
    const cur = running.get(id);
    if (cur) {
      if (force && cur.release) cur.release(); // a held countdown is cut short; a job that is already writing is left alone
      return { ok: true, running: true };
    }
    const job = { ctl: new AbortController(), held: false, release: null };
    running.set(id, job);
    job.done = pipeline(id, job, { force: force || resume, reread, resume }).finally(() => {
      running.delete(id);
      d.onIdle(running.size);
    });
    return { ok: true, started: true };
  }

  return {
    run,
    hold(id) {
      const j = running.get(id);
      if (!j) return { ok: true, running: false };
      j.held = true;
      j.release?.();
      return { ok: true, running: true };
    },
    abort(id) {
      running.get(id)?.ctl.abort();
      return { ok: true };
    },
    isRunning: (id) => running.has(id),
    count: () => running.size,
    whenIdle: () => Promise.allSettled([...running.values()].map((j) => j.done)),
  };
}
