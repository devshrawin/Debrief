import { renderMd } from './md.js';
import { mountAsk } from './askui.js';
import { getSettings, setSetting, llmReady, getMeeting, saveMeeting, deleteMeeting, fmtTime } from './store.js';
import { parseDictionary, applyDictionary, suggestNames, learnAlias, replaceWord, learnFromMeeting, mergeLearned } from './dictionary.js';
import { writeMinutes } from './minutes.js';
import { matchPeople } from './attendance.js';
import { labelTranscript, voicePresence, clusterVoices, unpack, pack, mean } from './voice/match.js';
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

// Names the user told us are in the meeting, plus the dictionary, as one context for every prompt and view.
const attendeeList = () => (meeting?.attendees || []).filter(Boolean);
// Voice-labelled lines of the remote speech, or null. Cheap enough to recompute, but cached while nothing changes.
let labelCache = { key: '', lines: null };
function labeledLines() {
  if (!settings.voiceOn || !meeting?.voiceSegs?.length || !settings.voices?.length) return null;
  const key = `${meeting.voiceSegs.length}|${meeting.segments.length}|${(meeting.captions || []).length}|${settings.voices.map((v) => `${v.id}${v.windows?.length}`).join(',')}`;
  if (labelCache.key !== key) labelCache = { key, lines: labelTranscript(meeting, settings.voices, { captions: meeting.captions, myName: settings.myName }) };
  return labelCache.lines;
}
const nameCtx = () => {
  const labeled = labeledLines();
  return { entries: parseDictionary(settings.dictionary), attendees: attendeeList(), learned: (settings.learnedNames || []).slice(-40), labeled, voicePresence: labeled ? voicePresence(labeled) : null };
};
const parseAttendees = (text) => text.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

function renderMom() {
  $('mom').innerHTML = meeting.mom ? renderMd(meeting.mom) : '<p class="muted">No minutes yet.</p>';
}

function renderMeta() {
  const start = new Date(meeting.startedAt);
  const dur = meeting.endedAt ? `${Math.max(1, Math.round((meeting.endedAt - meeting.startedAt) / 60000))} min` : 'in progress';
  $('meta').textContent = `${start.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${dur} · STT: ${meeting.stt}`;
  $('title').value = meeting.title;
  document.title = `${meeting.title} · Debrief`;
}

function renderTranscript() {
  const ctx = nameCtx();
  const rows = ctx.labeled
    ? ctx.labeled.map((l) => ({ t: l.t, src: l.src, who: l.label, text: l.text, flag: l.source === 'conflict' ? 'conflict' : l.name ? '' : 'unknown' }))
    : [...meeting.segments].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t, src: s.src, who: s.src === 'me' ? settings.myName || 'Me' : 'Others', text: s.text, flag: '' }));
  $('trInfo').textContent = `${rows.length} ${ctx.labeled ? 'lines, speakers named by voice recognition (a best guess)' : 'segments'}`;
  if (!rows.length) {
    $('transcript').innerHTML = '<p class="muted">No speech was transcribed.</p>';
    return;
  }
  $('transcript').replaceChildren(
    ...rows.map((r) => {
      const row = document.createElement('div');
      row.className = 'seg';
      row.innerHTML = `<span class="t"></span><span class="who"></span><span class="text"></span>`;
      row.children[0].textContent = fmtTime(r.t);
      row.children[1].textContent = r.who;
      row.children[1].className = `who ${r.src}${r.flag ? ` ${r.flag}` : ''}`;
      row.children[2].textContent = r.src === 'me' && !ctx.labeled ? applyDictionary(r.text, ctx.entries, ctx.attendees) : applyDictionary(r.text, ctx.entries, ctx.attendees);
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
async function patchMeeting(fields) {
  const latest = (await getMeeting(id)) || meeting;
  Object.assign(latest, fields);
  Object.assign(meeting, fields);
  await saveMeeting(latest);
}

async function runGenerate() {
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
  $('gen').disabled = true;
  $('abort').classList.remove('hidden');
  $('genStatus').textContent = `Writing with ${modelLabel(settings)}…`;
  let buf = '';
  let queued = false;
  const paint = () => {
    queued = false;
    $('mom').innerHTML = renderMd(buf);
  };
  // One model call with the same retry-on-rate-limit behaviour as before.
  const gen = async (system, user, onText) => {
    for (let i = 0; ; i++) {
      try {
        return await generate({ settings, system, user, signal: abortCtl.signal, onText: onText || (() => {}) });
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
    const { mom: text, stats } = await writeMinutes({
      meeting,
      settings,
      notes: meeting.notes,
      ctx: { ...ctx, absent, captions: meeting.captions },
      gen: (system, user, onText) =>
        gen(system, user, onText && ((d) => {
          buf += d;
          if (!queued) {
            queued = true;
            requestAnimationFrame(paint);
          }
        })),
      onText: () => {},
      onStatus: (t) => {
        buf = '';
        $('genStatus').textContent = t;
      },
      coverage: { pendingCount: pending.length, pendingSec: pending.reduce((a, p) => a + (p.wav.size - 44) / 32000, 0), errors: (meeting.errors || []).length },
    });
    await patchMeeting({ mom: text, model: modelLabel(settings), notes: meeting.notes, attendees: meeting.attendees });
    renderMom();
    $('genStatus').textContent = `Done · ${meeting.model}${stats.calls > 1 ? ` · ${stats.items} items found, ${stats.missed} added by the check` : ''}`;
    // First time only: regenerating or editing never re-sends by itself.
    if (settings.emailAuto && mailReady(settings) && !meeting.emailedAt && meeting.endedAt) emailMom(true);
  } catch (e) {
    $('genStatus').textContent = abortCtl.signal.aborted ? 'Stopped.' : `Failed: ${e.message}`;
    renderMom();
  } finally {
    abortCtl = null;
    $('gen').disabled = false;
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
      const mail = buildEmail(meeting, settings, renderMd, settings.emailTranscript ? formatTranscript(meeting, settings.myName, nameCtx()) : '');
      const r = await sendMail(mail, settings);
      await patchMeeting({ emailedAt: Date.now(), emailedTo: r.to });
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
    const mail = buildEmail(meeting, settings, renderMd, settings.emailTranscript ? formatTranscript(meeting, settings.myName, nameCtx()) : '');
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
    await patchMeeting({ ...(guests ? { invited: guests } : {}), invitedChecked: true });
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

$('gen').onclick = runGenerate;
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
  const html = wordDocHtml(renderMd(meeting.mom));
  download(`${fileBase()}.doc`, 'application/msword', html);
};
$('copy').onclick = async () => {
  setEditing(false);
  const html = renderMd(meeting.mom);
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
  if (!confirm('Delete this meeting, its transcript and MOM? This cannot be undone.')) return;
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
      b.textContent = `${x.found} → ${x.suggest} (${x.count}×)`;
      b.style.margin = '0 6px 4px 0';
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
  renderTranscript();
  renderSuggestions();
  learn().catch(() => {});
};

document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('momTab').classList.toggle('hidden', b.dataset.tab !== 'momTab');
    $('trTab').classList.toggle('hidden', b.dataset.tab !== 'trTab');
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
    $('gen').textContent = 'Regenerate';
    if (hadPending) $('genStatus').textContent = 'Missing audio was recovered. Press Regenerate to include it in the minutes.';
  } else if (!meeting.endedAt) {
    $('genStatus').textContent = 'This meeting is still being recorded. The minutes are written when it ends, or press Generate to try now.';
  } else if (meeting.segments.length) runGenerate();
})();
