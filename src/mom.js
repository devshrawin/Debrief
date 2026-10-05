import { marked } from 'marked';
import { getSettings, llmReady, getMeeting, saveMeeting, deleteMeeting, fmtTime } from './store.js';
import { generate, modelLabel, isRetryable } from './llm.js';
import { transcribe } from './stt.js';
import { listPending, deletePending, deleteAllPending } from './audiostore.js';
import { buildSystemPrompt, buildUserPrompt, formatTranscript } from './prompt.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
let meeting = null;
let settings = null;
let abortCtl = null;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Transcripts come from arbitrary speech, so never let raw HTML from the model through.
marked.use({ gfm: true, renderer: { html: ({ text }) => escapeHtml(text) } });

const renderMd = (md) => marked.parse(md || '');

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
  $('transcript').replaceChildren(
    ...segs.map((s) => {
      const row = document.createElement('div');
      row.className = 'seg';
      row.innerHTML = `<span class="t"></span><span class="who ${s.src}"></span><span class="text"></span>`;
      row.children[0].textContent = fmtTime(s.t);
      row.children[1].textContent = s.src === 'me' ? me : 'Others';
      row.children[2].textContent = s.text;
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
  const attempt = () => {
    buf = '';
    return generate({
      settings,
      system: buildSystemPrompt(settings.momLanguage),
      user: buildUserPrompt(meeting, settings, $('notes').value),
      signal: abortCtl.signal,
      onText: (d) => {
        buf += d;
        if (!queued) {
          queued = true;
          requestAnimationFrame(paint);
        }
      },
    });
  };
  try {
    let text;
    for (let i = 0; ; i++) {
      try {
        text = await attempt();
        break;
      } catch (e) {
        if (i >= 3 || !isRetryable(e)) throw e;
        const wait = [5, 15, 30][i];
        $('genStatus').textContent = `Attempt ${i + 1} failed (${e.message.slice(0, 80)}). Retrying in ${wait} s…`;
        await sleep(wait * 1000, abortCtl.signal);
        $('genStatus').textContent = `Writing with ${modelLabel(settings)} (attempt ${i + 2})…`;
      }
    }
    meeting.mom = text;
    meeting.notes = $('notes').value;
    meeting.model = modelLabel(settings);
    await saveMeeting(meeting);
    renderMom();
    $('genStatus').textContent = `Done · ${meeting.model}`;
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
$('abort').onclick = () => abortCtl?.abort();
$('edit').onclick = () => setEditing($('mdEdit').classList.contains('hidden'));
$('print').onclick = () => window.print();
$('dlMd').onclick = () => download(`${fileBase()}.md`, 'text/markdown', meeting.mom);
$('dlDoc').onclick = () => {
  // Word opens HTML saved with a .doc extension, tables and headings intact.
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>body{font-family:Calibri,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}</style></head><body>${renderMd(meeting.mom)}</body></html>`;
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
$('dlTxt').onclick = () => download(`Transcript ${fileBase().slice(4)}.txt`, 'text/plain', formatTranscript(meeting, settings.myName));
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
  renderMeta();
  renderErrors();
  renderTranscript();
  renderMom();
  $('retry').onclick = async () => {
    const left = await retryPending();
    if (!left && meeting.segments.length) $('genStatus').textContent = 'Transcript recovered. Press Regenerate to update the minutes.';
  };
  // Recover audio that failed mid-meeting before writing the minutes, so nothing is missing.
  const hadPending = (await listPending(id)).length > 0;
  if (hadPending) await retryPending();
  if (meeting.mom && !hadPending) $('gen').textContent = 'Regenerate';
  else if (meeting.segments.length && (!meeting.mom || hadPending)) runGenerate();
})();
