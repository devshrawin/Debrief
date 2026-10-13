import { marked } from 'marked';
import { getSettings, saveSettings, llmReady, getMeeting, saveMeeting, deleteMeeting, fmtTime } from './store.js';
import { parseDictionary, applyDictionary, suggestNames, learnAlias, replaceWord } from './dictionary.js';
import { writeMinutes } from './minutes.js';
import { matchPeople } from './attendance.js';
import { generate, modelLabel, isRetryable } from './llm.js';
import { transcribe } from './stt.js';
import { listPending, deletePending, deleteAllPending } from './audiostore.js';
import { buildSystemPrompt, buildUserPrompt, formatTranscript } from './prompt.js';
import { buildEmail, sendMail, mailReady, wordDocHtml } from './mailer.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
let meeting = null;
let settings = null;
let abortCtl = null;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Transcripts come from arbitrary speech, so never let raw HTML from the model through.
marked.use({ gfm: true, renderer: { html: ({ text }) => escapeHtml(text) } });

const renderMd = (md) => marked.parse(md || '');

// Names the user told us are in the meeting, plus the dictionary, as one context for every prompt and view.
const attendeeList = () => (meeting?.attendees || []).filter(Boolean);
const nameCtx = () => ({ entries: parseDictionary(settings.dictionary), attendees: attendeeList() });
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
  const segs = [...meeting.segments].sort((a, b) => a.t - b.t);
  $('trInfo').textContent = `${segs.length} segments`;
  if (!segs.length) {
    $('transcript').innerHTML = '<p class="muted">No speech was transcribed.</p>';
    return;
  }
  const me = settings.myName || 'Me';
  const ctx = nameCtx();
  $('transcript').replaceChildren(
    ...segs.map((s) => {
      const row = document.createElement('div');
      row.className = 'seg';
      row.innerHTML = `<span class="t"></span><span class="who ${s.src}"></span><span class="text"></span>`;
      row.children[0].textContent = fmtTime(s.t);
      row.children[1].textContent = s.src === 'me' ? me : 'Others';
      row.children[2].textContent = applyDictionary(s.text, ctx.entries, ctx.attendees);
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
    const absent = matchPeople(meeting.invited, meeting.presence, { entries: ctx.entries, myName: settings.myName }).rows.filter((r) => !r.present).map((r) => r.name);
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
    meeting.mom = text;
    meeting.model = modelLabel(settings);
    await saveMeeting(meeting);
    renderMom();
    $('genStatus').textContent = `Done · ${meeting.model}${stats.calls > 1 ? ` · ${stats.items} items found, ${stats.missed} added by the check` : ''}`;
    // First time only: regenerating or editing never re-sends by itself.
    if (settings.emailAuto && mailReady(settings) && !meeting.emailedAt) emailMom(true);
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
    const mail = buildEmail(meeting, settings, renderMd, settings.emailTranscript ? formatTranscript(meeting, settings.myName, nameCtx()) : '');
    const r = await sendMail(mail, settings);
    meeting.emailedAt = Date.now();
    meeting.emailedTo = r.to;
    await saveMeeting(meeting);
    $('mailStatus').textContent = `Emailed to ${r.to} ✓`;
    $('mail').textContent = 'Email again';
    chrome.notifications?.create(`debrief-mail-${meeting.id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Debrief: MOM emailed', message: `${meeting.title} was sent to ${r.to}.` });
  } catch (e) {
    $('mailStatus').textContent = `Email failed: ${e.message}`;
  } finally {
    $('mail').disabled = false;
  }
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
$('print').onclick = () => window.print();
$('dlMd').onclick = () => download(`${fileBase()}.md`, 'text/markdown', meeting.mom);
$('dlDoc').onclick = () => {
  const html = wordDocHtml(renderMd(meeting.mom));
  download(`${fileBase()}.doc`, 'application/msword', html);
};
$('copy').onclick = async () => {
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

async function fixName(wrong, right, remember) {
  wrong = wrong.trim();
  right = right.trim();
  if (!wrong || !right) {
    $('fixMsg').textContent = 'Enter both names.';
    return;
  }
  for (const seg of meeting.segments) seg.text = replaceWord(seg.text, wrong, right);
  if (meeting.mom) meeting.mom = replaceWord(meeting.mom, wrong, right);
  await saveMeeting(meeting);
  if (remember) {
    settings.dictionary = learnAlias(settings.dictionary, right, wrong);
    await saveSettings(settings);
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
  meeting.attendees = parseAttendees($('attendees').value);
  await saveMeeting(meeting);
  renderTranscript();
  renderSuggestions();
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
  $('notes').value = meeting.notes || '';
  $('attendees').value = (meeting.attendees || []).join('\n');
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
  if (meeting.mom && !hadPending) $('gen').textContent = 'Regenerate';
  else if (meeting.segments.length && (!meeting.mom || hadPending)) runGenerate();
})();
