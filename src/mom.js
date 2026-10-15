import { renderMd, decorateMinutes } from './md.js';
import { renderMinutesHtml, isAmnexMd } from './amnex.js';
import { mountAsk } from './askui.js';
import { modal } from './modal.js';
import { getSettings, setSetting, getVoices, saveVoices, llmReady, getMeeting, saveMeeting, deleteMeeting, fmtTime } from './store.js';
import { parseDictionary, applyDictionary, suggestNames, learnAlias, replaceWord, learnFromMeeting, mergeLearned } from './dictionary.js';
import { writeMinutes } from './minutes.js';
import { matchPeople } from './attendance.js';
import { labelTranscript, voicePresence } from './voice/match.js';
import { usableVoices, isAnon } from './voice/learn.js';
import { getSample, hasSample, deleteSample } from './voice/samples.js';
import { generate, modelLabel, isRetryable } from './llm.js';
import { transcribe } from './stt.js';
import { listPending, deletePending, deleteAllPending } from './audiostore.js';
import { buildSystemPrompt, buildUserPrompt, formatTranscript } from './prompt.js';
import { buildEmail, sendMail, mailReady, wordDocHtml, parseAddresses, recipientsFor, inviteeEmails, lookupInvitees } from './mailer.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
let meeting = null;
let settings = null;
let abortCtl = null;
let genFail = ''; // why the last attempt to write the minutes failed, shown in the red box

// Names the user told us are in the meeting, plus the dictionary, as one context for every prompt and view.
const attendeeList = () => (meeting?.attendees || []).filter(Boolean);
// Voice-labelled lines of the remote speech, or null. Cheap enough to recompute, but cached while nothing changes.
const labelCache = new Map(); // key -> lines (one entry per mode and state)
function labeledLines(forDisplay = false) {
  // Prompts and minutes only use voices that are named or trusted; the transcript view also shows the still-unnamed ones
  // ("Unnamed voice 2") so the user can see who said what and name them by reading.
  const people = forDisplay ? (settings.voices || []) : usableVoices(settings.voices);
  if (!settings.voiceOn || !meeting?.voiceSegs?.length || !people.length) return null;
  const key = `${forDisplay ? 'd' : 'n'}${meeting.room ? 'r' : ''}|${meeting.voiceSegs.length}|${meeting.segments.length}|${(meeting.captions || []).length}|${people.map((v) => `${v.id}${v.windows?.length}`).join(',')}`;
  if (!labelCache.has(key)) {
    if (labelCache.size > 8) labelCache.clear();
    labelCache.set(key, labelTranscript(meeting, people, { captions: meeting.captions, myName: settings.myName, room: !!meeting.room }));
  }
  return labelCache.get(key);
}
const nameCtx = () => {
  const labeled = labeledLines();
  return { entries: parseDictionary(settings.dictionary), attendees: attendeeList(), learned: (settings.learnedNames || []).slice(-40), labeled, room: !!meeting.room, voicePresence: labeled ? voicePresence(labeled) : null };
};
const parseAttendees = (text) => text.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

function renderMom() {
  // Minutes in the official Amnex format show as the A4 document (and print as such); anything else as markdown.
  $('mom').innerHTML = meeting.mom ? renderMinutesHtml(meeting.mom, renderMd) : '<p class="muted">No minutes yet.</p>';
  if (meeting.mom && !isAmnexMd(meeting.mom)) decorateMinutes($('mom'));
  $('mom').classList.remove('streaming');
  syncState();
  if (meeting) paintFormat();
}

// Shows one of: the minutes, the "no minutes yet" card, the generating skeleton; plus the red failure box.
function syncState() {
  const busy = !!abortCtl;
  const empty = !meeting.mom && !busy && !genFail;
  $('failBox').classList.toggle('hidden', !genFail || busy);
  $('failText').textContent = genFail ? `${genFail} Your transcript is safe.` : '';
  $('emptyBox').classList.toggle('hidden', !empty);
  $('mom').hidden = !meeting.mom && !busy;
  $('emptyText').textContent = !meeting.segments.length ? 'No speech was transcribed, so there is nothing to summarise yet.' : !meeting.endedAt ? 'This meeting is still being recorded. The minutes are written when it ends.' : 'The transcript is ready. Generate the minutes when you are.';
}

function showSkeleton() {
  $('mom').innerHTML = '<div class="skel" aria-hidden="true"><div class="busy"><span class="spin"></span>Writing the minutes…</div><div class="sk h"></div><div class="sk" style="width:96%"></div><div class="sk" style="width:88%"></div><div class="sk" style="width:92%"></div><div class="sk h"></div><div class="sk" style="width:70%"></div><div class="sk" style="width:82%"></div></div>';
  $('mom').hidden = false;
}

function renderMeta() {
  const start = new Date(meeting.startedAt);
  const dur = meeting.endedAt ? `${Math.max(1, Math.round((meeting.endedAt - meeting.startedAt) / 60000))} min` : 'in progress';
  const bits = [start.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }), dur];
  if (attendeeList().length) bits.push(attendeeList().join(', '));
  $('meta').replaceChildren(...bits.map((b, i) => Object.assign(document.createElement('span'), { textContent: b, className: i === 2 ? 'who-list' : '' })));
  renderChips();
  $('title').value = meeting.title;
  document.title = `${meeting.title} · Debrief`;
}

// Status chips under the title: emailed, the model that wrote the minutes, speech-to-text, completeness check.
function renderChips() {
  const chip = (text, cls = '') => Object.assign(document.createElement('span'), { className: `chip ${cls}`.trim(), textContent: text });
  const list = [];
  if (meeting.emailedAt) list.push(chip(`Emailed ${new Date(meeting.emailedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}`, 'brand'));
  if (meeting.room) list.push(chip('In a room', 'brand'));
  if (meeting.mom && meeting.model) list.push(chip(meeting.model));
  if (meeting.stt) list.push(chip(`STT: ${meeting.stt}`));
  if (meeting.mom && meeting.extract) list.push(chip('Checked for completeness', 'ok'));
  $('chips').replaceChildren(...list);
}

// Right after a meeting: the voices Debrief found in it that have no name yet, each with its audio clip (if kept) and
// what it said, so they can be named here and now. Naming confirms the voice for this and every later meeting.
let playing = null;
async function renderNameBox() {
  const here = (settings.voices || []).filter((v) => v.auto && isAnon(v) && (v.learnedFrom || []).includes(meeting.id));
  $('nameBox').classList.toggle('hidden', !here.length);
  if (!here.length) return;
  const lines = labeledLines(true) || [];
  const clips = await Promise.all(here.map((v) => hasSample(v.id).catch(() => false)));
  $('nameNote').textContent = clips.some(Boolean)
    ? 'Press Play, type who it is, and save. Then press Regenerate so the minutes use the names.'
    : settings.voiceSamples
      ? 'No audio clip was kept for these voices. Read what each one said below and type who it is. Then press Regenerate.'
      : 'No audio clips are kept: switch on "Keep short samples of unnamed voices" in Settings → Voices before the next meeting to get a Play button. Meanwhile read what each voice said and type who it is.';
  $('nameList').replaceChildren(
    ...here.map((v, i) => {
      const row = document.createElement('div');
      row.className = 'namerow';
      const who = Object.assign(document.createElement('span'), { className: 'who', textContent: v.name });
      const input = Object.assign(document.createElement('input'), { placeholder: 'Who is this?', maxLength: 60 });
      input.setAttribute('aria-label', `Name for ${v.name}`);
      const play = Object.assign(document.createElement('button'), { type: 'button', textContent: '▶ Play', hidden: !clips[i] });
      play.onclick = async () => {
        try {
          playing?.pause();
          const blob = await getSample(v.id);
          if (!blob) return (play.hidden = true);
          const url = URL.createObjectURL(blob);
          playing = new Audio(url);
          playing.onended = () => URL.revokeObjectURL(url);
          await playing.play();
        } catch {}
      };
      const save = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Save name' });
      save.onclick = async () => {
        const clean = input.value.trim().replace(/\s+/g, ' ').slice(0, 60);
        const all = await getVoices();
        if (!clean) return void input.focus();
        if (all.some((x) => x.id !== v.id && x.name.toLowerCase() === clean.toLowerCase())) {
          $('nameNote').textContent = `There is already a voice called ${clean}. Use Settings → Voices → Merge to join two voices of the same person.`;
          return;
        }
        await saveVoices(all.map((x) => (x.id === v.id ? { ...x, name: clean, confirmed: true } : x)));
        deleteSample(v.id).catch(() => {});
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
      const said = lines.filter((l) => l.name === v.name).slice(0, 2);
      const excerpt = Object.assign(document.createElement('p'), {
        className: 'said',
        textContent: said.length ? said.map((l) => `[${fmtTime(l.t)}] “${l.text.length > 110 ? `${l.text.slice(0, 107)}…` : l.text}”`).join('   ') : 'Nothing from this voice was long enough to show.',
      });
      row.append(who, input, play, save, excerpt);
      return row;
    })
  );
}

// Should the transcript go with the minutes? Per meeting: what the user chose when the recording stopped (or later), else
// the setting for the email to oneself, and "no" for people it is shared with.
const wantTranscript = (shared) => (shared ? !!meeting.transcriptShare : meeting.transcriptMine ?? !!settings.emailTranscript);

// ---- the choice offered when the recording stops: format, and whether the transcript goes out ----
const FORMATS = { amnex: 'Official Amnex format', standard: 'Debrief standard' };
const currentFormat = () => meeting.format || settings.minutesFormat || 'amnex';
function paintFormat() {
  const f = currentFormat();
  for (const seg of [$('fmtSeg'), $('fmtSwitch')]) for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === f));
  $('fmtSwitch').classList.toggle('hidden', !meeting.mom);
  $('chkMine').checked = wantTranscript(false);
  $('chkShare').checked = wantTranscript(true);
  $('mailTranscript').checked = wantTranscript(false);
  $('shareTranscript').checked = wantTranscript(true);
}
async function chooseFormat(v, regenerate) {
  if (v === currentFormat()) return;
  await patchMeeting({ format: v });
  paintFormat();
  if (regenerate && meeting.mom && !abortCtl) {
    $('genStatus').textContent = `Switching to the ${FORMATS[v]}…`;
    runGenerate();
  }
}
for (const b of $('fmtSeg').querySelectorAll('button')) b.onclick = () => chooseFormat(b.dataset.v, false);
for (const b of $('fmtSwitch').querySelectorAll('button')) b.onclick = () => chooseFormat(b.dataset.v, true);
$('chkMine').onchange = $('mailTranscript').onchange = async (e) => {
  await patchMeeting({ transcriptMine: e.target.checked });
  paintFormat();
};
$('chkShare').onchange = $('shareTranscript').onchange = async (e) => {
  await patchMeeting({ transcriptShare: e.target.checked });
  paintFormat();
};

// The card waits a few seconds and then writes the minutes by itself, so an unattended recording still ends with
// minutes (and the automatic email). Touching anything on the card stops the countdown.
let countdown = null;
function offerChoices() {
  paintFormat();
  $('startCard').classList.remove('hidden');
  let left = 10;
  const tick = () => {
    $('startCount').textContent = `Writing automatically in ${left} s`;
    if (left-- <= 0) return startWriting();
    countdown = setTimeout(tick, 1000);
  };
  const stopCount = () => {
    clearTimeout(countdown);
    countdown = null;
    $('startCount').textContent = 'Press the button when you are ready.';
  };
  $('startCard').addEventListener('pointerdown', stopCount, { once: true });
  $('startCard').addEventListener('keydown', stopCount, { once: true });
  tick();
}
async function startWriting() {
  clearTimeout(countdown);
  $('startCard').classList.add('hidden');
  await patchMeeting({ decided: true });
  runGenerate();
}
$('startNow').onclick = startWriting;

function renderTranscript() {
  const ctx = nameCtx();
  const shown = labeledLines(true);
  const rows = shown
    ? shown.map((l) => ({ t: l.t, src: l.src, who: l.label, text: l.text, flag: l.source === 'conflict' ? 'conflict' : l.name ? '' : 'unknown' }))
    : [...meeting.segments].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t, src: s.src, who: s.src === 'me' ? (meeting.room ? 'Room' : settings.myName || 'Me') : 'Others', text: s.text, flag: '' }));
  // pauses show as notes in their place, so a gap in the transcript is explained
  for (const p of meeting.pauses || []) rows.push({ t: p.from, src: 'note', who: 'Paused', text: `Recording was paused from ${fmtTime(p.from)} to ${p.to != null ? fmtTime(p.to) : 'the end'}. Nothing from this stretch was transcribed or kept.`, flag: '' });
  rows.sort((a, b) => a.t - b.t);
  renderNameBox().catch(() => {});
  $('trInfo').textContent = `${rows.length} ${shown ? 'lines, speakers named by voice recognition (a best guess)' : 'segments'}`;
  $('trCount').textContent = rows.length ? `${rows.length} line${rows.length === 1 ? '' : 's'}` : '';
  if (!rows.length) {
    $('transcript').innerHTML = '<p class="tr-empty">No speech was transcribed.</p>';
    return;
  }
  $('transcript').replaceChildren(
    ...rows.map((r) => {
      const row = document.createElement('div');
      row.className = 'seg';
      row.innerHTML = `<span class="t"></span><span class="who"></span><span class="text"></span>`;
      row.children[0].textContent = fmtTime(r.t);
      row.children[1].textContent = r.who;
      row.children[1].className = `who ${r.src}${r.flag ? ` ${r.flag}` : shown ? ' named' : ''}`;
      row.children[2].textContent = r.src === 'me' && !shown ? applyDictionary(r.text, ctx.entries, ctx.attendees) : applyDictionary(r.text, ctx.entries, ctx.attendees);
      return row;
    })
  );
}

function renderErrors() {
  const errs = meeting.errors || [];
  $('errors').classList.toggle('hidden', !errs.length);
  if (errs.length) {
    $('errors').textContent = `${errs.length} problem${errs.length > 1 ? 's' : ''} during transcription (some audio may be missing). Last: ${errs[errs.length - 1]}`;
  }
}

// Saves only the fields that changed onto the stored meeting, so another tab's or the recorder's newer
// writes (segments, captions, emailedAt) are never overwritten by this page's older copy.
// Changes are applied one after the other: two quick changes (a checkbox and a format) must not overwrite each other.
let patchChain = Promise.resolve();
function patchMeeting(fields) {
  const run = patchChain.then(async () => {
    const latest = (await getMeeting(id)) || meeting;
    Object.assign(latest, fields);
    Object.assign(meeting, fields);
    await saveMeeting(latest);
  });
  patchChain = run.catch(() => {});
  return run;
}

async function runGenerate({ reread = false } = {}) {
  if (!llmReady(settings)) {
    $('genStatus').textContent = 'Set up an LLM in Settings first.';
    return;
  }
  if (!meeting.segments.length) {
    $('genStatus').textContent = 'Nothing to summarise: the transcript is empty.';
    return;
  }
  setEditing(false);
  abortCtl = new AbortController();
  genFail = '';
  $('gen').disabled = true;
  $('reread').disabled = true;
  $('abort').classList.remove('hidden');
  $('genStatus').classList.add('busy');
  $('genStatus').textContent = `Writing with ${modelLabel(settings)}…`;
  showSkeleton();
  syncState();
  let buf = '';
  let queued = false;
  const paint = () => {
    queued = false;
    $('mom').innerHTML = renderMd(buf);
    decorateMinutes($('mom'));
    $('mom').classList.add('streaming');
  };
  // One model call with the same retry-on-rate-limit behaviour as before.
  const gen = async (system, user, onText, opts = {}) => {
    for (let i = 0; ; i++) {
      try {
        return await generate({ settings, system, user, signal: abortCtl.signal, onText: onText || (() => {}), temperature: opts.temperature });
      } catch (e) {
        if (i >= 3 || !isRetryable(e)) throw e;
        const wait = [5, 15, 30][i];
        $('genStatus').textContent = `Attempt ${i + 1} failed (${e.message.slice(0, 80)}). Retrying in ${wait} s…`;
        await sleep(wait * 1000, abortCtl.signal);
      }
    }
  };
  try {
    meeting.notes = $('notes').value;
    const pending = await listPending(id);
    const ctx = nameCtx();
    const absent = matchPeople(meeting.invited, { ...(ctx.voicePresence || {}), ...(meeting.presence || {}) }, { entries: ctx.entries, myName: settings.myName }).rows.filter((r) => !r.present).map((r) => r.name);
    const { mom: text, stats, extract } = await writeMinutes({
      meeting,
      settings: { ...settings, minutesFormat: meeting.format || settings.minutesFormat },
      notes: meeting.notes,
      ctx: { ...ctx, absent, captions: meeting.captions, reread },
      gen: (system, user, onText, opts) =>
        gen(system, user, onText && ((d) => {
          buf += d;
          if (!queued) {
            queued = true;
            requestAnimationFrame(paint);
          }
        }), opts),
      onText: () => {},
      onStatus: (t) => {
        buf = '';
        $('genStatus').textContent = t;
      },
      coverage: { pendingCount: pending.length, pendingSec: pending.reduce((a, p) => a + (p.wav.size - 44) / 32000, 0), errors: (meeting.errors || []).length },
    });
    await patchMeeting({ mom: text, model: modelLabel(settings), notes: meeting.notes, attendees: meeting.attendees, ...(extract ? { extract } : {}) });
    renderMom();
    renderChips();
    $('genStatus').textContent = `Done · ${meeting.model}${stats.fellBack ? ' · the reply did not fit the official format, so standard minutes were written' : ''}${stats.calls > 1 ? ` · ${stats.items} items ${stats.reused ? 'reused from the earlier read of this transcript (press Re-read transcript for a fresh read)' : 'found'}, ${stats.missed} added by the check` : ''}`;
    // First time only: regenerating or editing never re-sends by itself.
    if (settings.emailAuto && mailReady(settings) && !meeting.emailedAt && meeting.endedAt) emailMom(true);
  } catch (e) {
    genFail = abortCtl.signal.aborted ? '' : e.message;
    $('genStatus').textContent = abortCtl.signal.aborted ? 'Stopped.' : `Failed: ${e.message}`;
    abortCtl = null;
    renderMom();
  } finally {
    abortCtl = null;
    syncState();
    $('genStatus').classList.remove('busy');
    $('gen').disabled = false;
    $('reread').disabled = false;
    $('reread').classList.toggle('hidden', !meeting.extract);
    $('gen').textContent = 'Regenerate';
    $('abort').classList.add('hidden');
  }
}

async function emailMom(auto) {
  setEditing(false); // what is on screen is what gets sent, including unsaved edits
  if (!meeting.mom?.trim()) {
    $('mailStatus').textContent = 'No minutes to email yet.';
    return;
  }
  if (!mailReady(settings)) {
    $('mailStatus').textContent = 'Email is not set up. Add the Apps Script URL in Settings.';
    return;
  }
  $('mail').disabled = true;
  $('mailStatus').textContent = auto ? 'Emailing the minutes…' : 'Sending…';
  try {
    // One tab at a time: two tabs finishing together (the one opened after Stop and one opened from the
    // popup) must not both send the automatic email.
    await navigator.locks.request(`debrief-email-${id}`, async () => {
      if (auto) {
        const latest = await getMeeting(id);
        if (latest?.emailedAt) {
          Object.assign(meeting, { emailedAt: latest.emailedAt, emailedTo: latest.emailedTo });
          $('mailStatus').textContent = `Emailed to ${latest.emailedTo || 'you'} ✓`;
          return;
        }
      }
      const mail = buildEmail(meeting, { ...settings, emailTranscript: wantTranscript(false) }, renderMd, wantTranscript(false) ? formatTranscript(meeting, settings.myName, nameCtx()) : '');
      const r = await sendMail(mail, settings);
      await patchMeeting({ emailedAt: Date.now(), emailedTo: r.to });
      renderChips();
      $('mailStatus').textContent = `Emailed to ${r.to} ✓`;
      $('mail').textContent = 'Email again';
      chrome.notifications?.create(`debrief-mail-${meeting.id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Debrief: minutes emailed', message: 'The minutes were sent.' });
      if (auto && settings.shareMode === 'auto' && !meeting.sharedAt) shareMom(true).catch(() => {});
    });
  } catch (e) {
    $('mailStatus').textContent = `Email failed: ${e.message}`;
  } finally {
    $('mail').disabled = false;
  }
}

// ---- ask about this meeting ----
function mountAskBox() {
  const box = $('askBox');
  box.replaceChildren(Object.assign(document.createElement('h3'), { textContent: 'Ask about this meeting' }));
  mountAsk(box, {
    getMeetings: async () => [(await getMeeting(id)) || meeting],
    getCtx: () => ({ ...nameCtx(), myName: settings.myName }),
    history: meeting.qa || [],
    onEntry: (entry) => patchMeeting({ qa: [...(meeting.qa || []), entry].slice(-10) }),
    placeholder: 'Ask about these minutes, e.g. "who owns the Kerala mapping?"',
  });
}

// ---- sharing with other people ----
function absentNames() {
  return matchPeople(meeting.invited, { ...(nameCtx().voicePresence || {}), ...(meeting.presence || {}) }, { entries: parseDictionary(settings.dictionary), myName: settings.myName }).rows.filter((r) => !r.present).map((r) => r.name || r.email);
}

function initShare() {
  const saved = meeting.shareTo;
  const r = recipientsFor(meeting, settings);
  $('shareTo').value = (saved || r.list).join(', ');
  $('shareSrc').textContent = saved ? 'Last used for this meeting.' : r.list.length ? `Filled in from ${r.source}.` : 'Add the people who should get a copy.';
  $('shareHowSel').value = settings.shareHow || 'to';
  const hasInv = (meeting.invited || []).some((p) => p.email);
  $('shareInvited').classList.toggle('hidden', !hasInv);
  $('shareAbsent').classList.toggle('hidden', !hasInv || !meeting.presence);
  if (meeting.sharedAt) $('shareStatus').textContent = `Shared with ${(meeting.sharedTo || []).join(', ')} ✓`;
}

async function shareMom(auto) {
  setEditing(false);
  if (!meeting.mom?.trim()) {
    $('shareStatus').textContent = 'No minutes to share yet.';
    return;
  }
  if (!mailReady(settings)) {
    $('shareStatus').textContent = 'Email is not set up. Add the Apps Script URL in Settings.';
    return;
  }
  const list = parseAddresses($('shareTo').value || (auto ? recipientsFor(meeting, settings).list.join(',') : ''));
  if (!list.length) {
    $('shareStatus').textContent = auto ? '' : 'Add at least one email address.';
    return;
  }
  const how = auto ? settings.shareHow || 'to' : $('shareHowSel').value;
  $('shareSend').disabled = true;
  $('shareStatus').textContent = `Sending to ${list.length} ${list.length === 1 ? 'person' : 'people'}…`;
  try {
    const mail = buildEmail(meeting, { ...settings, emailTranscript: wantTranscript(true) }, renderMd, wantTranscript(true) ? formatTranscript(meeting, settings.myName, nameCtx()) : '');
    const r = await sendMail(mail, settings, { to: how === 'to' ? list.join(',') : '', cc: how === 'cc' ? list.join(',') : '', bcc: how === 'bcc' ? list.join(',') : '' });
    const sent = [...(r.to && how === 'to' ? String(r.to).split(',') : []), ...(r.cc || []), ...(r.bcc || [])];
    await patchMeeting({ sharedAt: Date.now(), sharedTo: sent, shareTo: list });
    $('shareStatus').textContent = r.skipped?.length
      ? `Sent to ${sent.join(', ') || 'nobody'}. Not allowed by your script: ${r.skipped.join(', ')}. Add them under Settings → Email → Sharing, copy the updated script and deploy a new version.`
      : `Shared with ${sent.join(', ')} ✓`;
  } catch (e) {
    $('shareStatus').textContent = `Share failed: ${e.message}`;
  } finally {
    $('shareSend').disabled = false;
  }
}

const addTo = (emails) => ($('shareTo').value = parseAddresses(`${$('shareTo').value},${emails.join(',')}`).join(', '));
$('shareSend').onclick = () => shareMom(false);
$('shareInvited').onclick = () => addTo(inviteeEmails(meeting));
$('shareAbsent').onclick = () => addTo(inviteeEmails(meeting, { absentOnly: true, absentNames: absentNames() }));

// Who was invited, from the calendar through the relay. Quiet if it is not set up or not permitted yet.
async function ensureInvited() {
  if (meeting.invitedChecked || !settings.calendarLookup || !mailReady(settings) || !meeting.endedAt) return;
  try {
    const guests = await lookupInvitees(meeting, settings);
    await patchMeeting({ ...(guests ? { invited: [...guests], invitedHow: guests.how, invitedEvent: guests.event, invitedError: null } : { invitedNotFound: true }), invitedChecked: true });
  } catch (e) {
    await patchMeeting({ invitedError: e.message });
  }
}

// Pre-fill the attendee list: who was actually seen (matched to calendar names), else who was invited.
function ensureAttendees() {
  if (meeting.attendees?.length) return;
  const entries = parseDictionary(settings.dictionary);
  const seen = { ...(nameCtx().voicePresence || {}), ...(meeting.presence || {}) };
  const presence = Object.entries(seen).map(([name]) => (/^you$/i.test(name) && settings.myName ? settings.myName : name));
  let names = [];
  if (presence.length) {
    const m = matchPeople(meeting.invited, seen, { entries, myName: settings.myName });
    names = [...m.rows.filter((r) => r.present).map((r) => r.name), ...m.uninvited.map((p) => p.name)];
  } else if (meeting.invited?.length) {
    names = meeting.invited.filter((p) => p.status !== 'no').map((p) => p.name || p.email.split('@')[0]);
  }
  if (names.length) meeting.attendees = [...new Set(names)];
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    });
  });

// Re-transcribes audio chunks that failed during the meeting. Returns how many are still failing.
async function retryPending() {
  let pending = await listPending(id);
  if (!pending.length) return 0;
  $('retry').disabled = true;
  let done = 0;
  let lastError = null;
  for (const p of pending) {
    $('pendingText').textContent = `Transcribing ${pending.length} audio piece${pending.length > 1 ? 's' : ''} that failed during the meeting… (${done}/${pending.length})`;
    try {
      const text = await transcribe(p.wav, settings);
      if (text) meeting.segments.push({ t: p.t, src: p.src, text, recovered: true });
      await deletePending(p.id);
      await saveMeeting(meeting);
      done++;
    } catch (e) {
      lastError = e.message;
    }
  }
  renderTranscript();
  pending = await listPending(id);
  renderPending(pending, lastError);
  $('retry').disabled = false;
  return pending.length;
}

function renderPending(pending, lastError) {
  $('pendingBox').classList.toggle('hidden', !pending.length);
  if (pending.length) {
    const mins = Math.round(pending.reduce((a, p) => a + (p.wav.size - 44) / 32000, 0) / 60 * 10) / 10;
    $('pendingText').textContent = `${pending.length} audio piece${pending.length > 1 ? 's' : ''} (~${mins} min) still not transcribed. Last error: ${(lastError || pending[pending.length - 1].error).slice(0, 200)}`;
  }
}

function setEditing(on) {
  if (!on && !$('mdEdit').classList.contains('hidden')) {
    meeting.mom = $('mdEdit').value;
    saveMeeting(meeting);
    renderMom();
  }
  $('mdEdit').classList.toggle('hidden', !on);
  $('mom').classList.toggle('hidden', on);
  $('edit').textContent = on ? 'Done editing' : 'Edit';
  if (on) $('mdEdit').value = meeting.mom;
}

function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => `MOM ${meeting.title} ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`.replace(/[\\/:*?"<>|]+/g, '-');

$('gen').onclick = () => runGenerate();
// Voices named, merged or deleted while a meeting is open: show the new names and say what to press.
chrome.storage.onChanged.addListener(async (c) => {
  if (!c.voices && !c.settings) return;
  try {
    settings = await getSettings();
    labelCache.clear();
    renderTranscript();
    if (c.voices && meeting?.mom && !abortCtl && labeledLines()) $('genStatus').textContent = 'Voices changed since these minutes were written. Press Regenerate to use the names.';
  } catch {}
});
$('reread').onclick = () => runGenerate({ reread: true });
$('mail').onclick = () => emailMom(false);
$('abort').onclick = () => abortCtl?.abort();
$('edit').onclick = () => setEditing($('mdEdit').classList.contains('hidden'));
$('print').onclick = () => {
  setEditing(false);
  window.print();
};
$('dlMd').onclick = () => (setEditing(false), download(`${fileBase()}.md`, 'text/markdown', meeting.mom));
$('dlDoc').onclick = () => {
  setEditing(false);
  const html = wordDocHtml(renderMd(meeting.mom), { md: meeting.mom });
  download(`${fileBase()}.doc`, 'application/msword', html);
};
$('copy').onclick = async () => {
  setEditing(false);
  const html = renderMinutesHtml(meeting.mom, renderMd);
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([meeting.mom], { type: 'text/plain' }),
    }),
  ]);
  $('copy').textContent = 'Copied ✓';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
};
$('dlTxt').onclick = () => download(`Transcript ${fileBase().slice(4)}.txt`, 'text/plain', formatTranscript(meeting, settings.myName, nameCtx()));
$('del').onclick = async () => {
  const ok = await modal({ title: 'Delete this meeting?', text: 'Its transcript and minutes are removed from this computer. This cannot be undone.', buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Delete meeting', value: 'yes', danger: true }] });
  if (ok?.value !== 'yes') return;
  await deleteMeeting(id);
  await deleteAllPending(id);
  window.close();
};
$('title').onchange = async () => {
  meeting.title = $('title').value.trim() || 'Meeting';
  await saveMeeting(meeting);
  renderMeta();
};

function renderSuggestions() {
  const box = $('suggest');
  const text = meeting.segments.map((x) => x.text).join(' ');
  const list = suggestNames(text, attendeeList(), parseDictionary(settings.dictionary));
  box.classList.toggle('hidden', !list.length);
  box.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'hint', textContent: 'Possible misheard names: ' }),
    ...list.map((x) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = `${x.found} → ${x.suggest} (${x.count}×)`;
      b.onclick = () => fixName(x.found, x.suggest, true);
      return b;
    })
  );
}

// Remembers the names this meeting proved to be real, and queues likely mishearings for approval.
async function learn() {
  const found = learnFromMeeting(meeting, { entries: parseDictionary(settings.dictionary), myName: settings.myName });
  if (!found.names.length && !found.candidates.length) return;
  const { learned } = await chrome.storage.local.get('learned');
  const { learned: next, accepted } = mergeLearned(learned, meeting.learnedAt ? { ...found, candidates: [] } : found, { auto: settings.dictAutoAlias, title: meeting.title });
  for (const a of accepted) settings.dictionary = learnAlias(settings.dictionary, a.suggest, a.found);
  if (accepted.length) await setSetting({ dictionary: settings.dictionary });
  await chrome.storage.local.set({ learned: next });
  await patchMeeting({ learnedAt: Date.now() });
}

async function fixName(wrong, right, remember) {
  wrong = wrong.trim();
  right = right.trim();
  if (!wrong || !right) {
    $('fixMsg').textContent = 'Enter both names.';
    return;
  }
  const latest = (await getMeeting(id)) || meeting;
  for (const seg of latest.segments) seg.text = replaceWord(seg.text, wrong, right);
  if (latest.mom) latest.mom = replaceWord(latest.mom, wrong, right);
  await saveMeeting(latest);
  meeting = latest;
  if (remember) {
    settings.dictionary = learnAlias(settings.dictionary, right, wrong);
    await setSetting({ dictionary: settings.dictionary });
  }
  $('fixMsg').textContent = `Replaced "${wrong}" with "${right}"${remember ? ' and remembered it' : ''}.`;
  $('fixWrong').value = '';
  $('fixRight').value = '';
  renderTranscript();
  renderMom();
  renderSuggestions();
}

$('fixApply').onclick = () => fixName($('fixWrong').value, $('fixRight').value, $('fixRemember').checked);
$('attendees').onchange = async () => {
  await patchMeeting({ attendees: parseAttendees($('attendees').value) });
  renderMeta();
  renderTranscript();
  renderSuggestions();
  learn().catch(() => {});
};

$('genEmpty').onclick = () => runGenerate();
$('failRetry').onclick = () => runGenerate();

// Tabs: click, or arrow keys / Home / End on the tab list (roving tabindex).
const tabBtns = [...document.querySelectorAll('.tabs button')];
const showTab = (b, focus) => {
  tabBtns.forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-selected', String(x === b));
    x.tabIndex = x === b ? 0 : -1;
  });
  $('momTab').classList.toggle('hidden', b.dataset.tab !== 'momTab');
  $('trTab').classList.toggle('hidden', b.dataset.tab !== 'trTab');
  if (focus) b.focus();
};
tabBtns.forEach((b, i) => {
  b.onclick = () => showTab(b);
  b.onkeydown = (e) => {
    const to = { ArrowRight: (i + 1) % tabBtns.length, ArrowLeft: (i + tabBtns.length - 1) % tabBtns.length, Home: 0, End: tabBtns.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    showTab(tabBtns[to], true);
  };
});

(async () => {
  settings = await getSettings();
  meeting = await getMeeting(id);
  if (!meeting) {
    document.querySelector('main').innerHTML = '<p>Meeting not found.</p>';
    return;
  }
  await ensureInvited();
  ensureAttendees();
  learn().catch(() => {});
  $('notes').value = meeting.notes || '';
  $('attendees').value = (meeting.attendees || []).join('\n');
  initShare();
  mountAskBox();
  renderMeta();
  renderErrors();
  renderTranscript();
  renderSuggestions();
  renderMom();
  $('retry').onclick = async () => {
    const left = await retryPending();
    if (!left && meeting.segments.length) $('genStatus').textContent = 'Transcript recovered. Press Regenerate to update the minutes.';
  };
  // Recover audio that failed mid-meeting before writing the minutes, so nothing is missing.
  const hadPending = (await listPending(id)).length > 0;
  if (hadPending) await retryPending();
  if (meeting.emailedAt) {
    $('mailStatus').textContent = `Emailed to ${meeting.emailedTo || 'you'} ✓`;
    $('mail').textContent = 'Email again';
  }
  if (meeting.mom) {
    paintFormat();
    $('gen').textContent = 'Regenerate';
    $('reread').classList.toggle('hidden', !meeting.extract);
    if (hadPending) $('genStatus').textContent = 'Missing audio was recovered. Press Regenerate to include it in the minutes.';
  } else if (!meeting.endedAt) {
    $('genStatus').textContent = 'This meeting is still being recorded. The minutes are written when it ends, or press Generate to try now.';
  } else if (meeting.segments.length) {
    paintFormat();
    if (meeting.decided) runGenerate();
    else offerChoices();
  }
})();
