// Writing the minutes and sending them are a JOB that belongs to the meeting, not to a page. The same code runs in the
// background (the offscreen document) so the minutes and the email happen even when no minutes tab is open, and in the
// minutes page itself only when no background runner can be reached. The page is a viewer: it shows the job's progress.
//
// Job state lives in meeting.job: { state, error, beat, held, countdownEnd }
//   queued -> transcribing-retry -> writing -> emailing -> done | failed
// "held" = the person touched the minutes page during the countdown, so nothing starts until they press Write minutes.

import { getMeeting, saveMeeting, patchMeeting, getSettings, llmReady, mergeEmailNames } from './store.js';
import { parseDictionary } from './dictionary.js';
import { writeMinutes } from './minutes.js';
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

export { ACTIVE, isActive, STALE_MS, COUNTDOWN_MS, stuckJobs };

// The offscreen document has no chrome.storage: there, the store calls are sent to the service worker (see useStore).
let IO = { getMeeting, saveMeeting, patchMeeting, getSettings, mergeEmailNames };
export function useStore(io) {
  IO = { ...IO, ...io };
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
    attendees: (meeting?.attendees || []).filter(Boolean),
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
      if (text) for (const seg of p.tl ? attributeMixed(text, p.t, p.tl) : [{ t: p.t, src: p.src, text }]) meeting.segments.push({ ...seg, recovered: true });
      await deletePending(p.id);
      await IO.saveMeeting(meeting);
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
export async function emailMinutes({ meeting, settings, auto, patch, getLatest, ctxFor, notify = () => {} }) {
  if (!meeting.mom?.trim()) return { status: 'No minutes to email yet.' };
  if (!mailReady(settings)) return { status: 'Email is not set up. Add the Apps Script URL in Settings.' };
  const run = async () => {
    if (auto) {
      const latest = await getLatest();
      if (latest?.emailedAt) {
        Object.assign(meeting, { emailedAt: latest.emailedAt, emailedTo: latest.emailedTo });
        return { status: `Emailed to ${latest.emailedTo || 'you'} ✓`, sent: false };
      }
      if (latest?.emailSending) return { status: 'The email may already have been sent. Check your inbox; press Email to send it again.', unsure: true };
      await patch({ emailSending: Date.now() });
    }
    const withTr = wantTranscript(meeting, settings, false);
    const mail = buildEmail(meeting, { ...settings, emailTranscript: withTr }, renderMd, withTr ? formatTranscript(meeting, settings.myName, ctxFor()) : '');
    const r = await sendMail(mail, settings);
    await patch({ emailedAt: Date.now(), emailedTo: r.to, emailSending: null });
    notify({ id: `debrief-mail-${meeting.id}`, title: 'Debrief: minutes emailed', message: 'The minutes were sent.' });
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
  await patch({ sharedAt: Date.now(), sharedTo: sent, shareTo: list });
  return {
    sent,
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
export async function generateWithRetry({ generate = realGenerate, settings, system, user, signal, onText, temperature, onRetry = () => {}, wait = [5, 15, 30] }) {
  for (let i = 0; ; i++) {
    try {
      return await generate({ settings, system, user, signal, onText: onText || (() => {}), temperature });
    } catch (e) {
      if (i >= 3 || !isRetryable(e)) throw e;
      onRetry(i + 1, e, wait[i]);
      await sleep(wait[i] * 1000, signal);
    }
  }
}

// The whole write: the model calls, saving the minutes, the pending-audio count for the coverage note.
// `ui` has onStatus(text) and onText(delta). Returns { text, stats }.
export async function writeAndStore({ id, meeting, settings, reread = false, signal, ui, patch, cache, generate }) {
  const pending = await listPending(id);
  const ctx = nameCtxFor(meeting, settings, cache);
  const absent = matchPeople(meeting.invited, { ...(ctx.voicePresence || {}), ...(meeting.presence || {}) }, { entries: ctx.entries, myName: settings.myName }).rows.filter((r) => !r.present).map((r) => r.name); // names only: no addresses go to the model
  const { mom: text, stats, extract } = await writeMinutes({
    meeting,
    settings: { ...settings, minutesFormat: meeting.format || settings.minutesFormat },
    notes: meeting.notes,
    ctx: { ...ctx, absent, captions: meeting.captions, reread },
    gen: (system, user, onText, opts) =>
      generateWithRetry({
        generate, settings, system, user, signal, onText: onText && ui.onText, temperature: opts?.temperature,
        onRetry: (n, e, wait) => ui.onStatus(`Attempt ${n} failed (${e.message.slice(0, 80)}). Retrying in ${wait} s…`, { keep: true }),
      }),
    onText: () => {},
    onStatus: (t) => ui.onStatus(t),
    coverage: { pendingCount: pending.length, pendingSec: pending.reduce((a, p) => a + (p.wav.size - 44) / 32000, 0), errors: (meeting.errors || []).length },
  });
  await patch({ mom: text, editedAt: null, model: modelLabel(settings), notes: meeting.notes, attendees: meeting.attendees, ...(extract ? { extract } : {}) });
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
    const patch = (fields) => {
      // a small update of just these fields (the heartbeat and the status are written every few seconds)
      const run = chain.then(async () => {
        if (meeting) Object.assign(meeting, fields);
        await d.patchMeeting(id, fields);
      });
      chain = run.catch(() => {});
      return run;
    };
    const cache = new Map();
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
    let buf = '';
    let lastEmit = 0;
    const ui = {
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

      await patch({ decided: true });
      let result = { stats: meeting.job?.stats };
      if (!skipWrite) {
        await setJob({ state: 'writing', status: null, countdownEnd: null, held: false });
        try {
          result = await writeAndStore({ id, meeting, settings, reread, signal: job.ctl.signal, ui, patch, cache, generate: d.generate });
        } catch (e) {
          const stopped = job.ctl.signal.aborted;
          return await setJob({ state: 'failed', error: stopped ? 'Stopped.' : e.message, aborted: stopped });
        }
      }

      // first time only: regenerating or editing never re-sends by itself
      if (settings.emailAuto && mailReady(settings) && !meeting.emailedAt && meeting.endedAt) {
        await setJob({ state: 'emailing' });
        const r = await emailMinutes({ meeting, settings, auto: true, patch, getLatest: () => d.getMeeting(id), ctxFor: () => nameCtxFor(meeting, settings, cache), notify: d.notify });
        if (r.failed || r.unsure) await setJob({ state: 'failed', error: r.status, stats: result.stats });
        else {
          if (r.sent && settings.shareMode === 'auto' && !meeting.sharedAt) {
            const rec = recipientsFor(meeting, settings);
            const list = parseAddresses((meeting.shareTo || rec.list).join(','));
            if (list.length) await shareMinutes({ meeting, settings, list, how: settings.shareHow || 'to', patch, ctxFor: () => nameCtxFor(meeting, settings, cache) }).catch(() => {});
          }
          await setJob({ state: 'done', error: null, stats: result.stats });
        }
      } else await setJob({ state: 'done', error: null, stats: result.stats });
    } catch (e) {
      await setJob({ state: 'failed', error: e.message }).catch(() => {});
    } finally {
      clearInterval(beat);
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
