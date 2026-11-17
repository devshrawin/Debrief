// Extras of the minutes page (extension/mom.html), kept out of mom.js: play a line of the kept recording, read a stretch
// again, tick off actions, notes about the shared screen, the share confirmation, the .json download.
// Everything built from meeting, settings or model text uses textContent or DOM methods, never an HTML string.
// The pure parts (matching, ranges, file names) are in actionslogic.js.
import { fmtDay } from './datefmt.js';
import { listSegs, segAt, segRange, pcm16kRange } from './audiokeep.js';
import { transcribeDetailed } from './stt.js';
import { encodeWav } from './wav.js';
import { exportMeeting } from './backup.js';
import { setActionDone } from './jobs.js';
import { getMeeting, getMeetingMeta, replaceMeetingList, sttReady, fmtTime } from './store.js';
import * as L from './actionslogic.js';

const SVG = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
function icon(...shapes) {
  const s = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  for (const [tag, attrs] of shapes) {
    const p = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    s.append(p);
  }
  return s;
}
const PLAY = () => icon(['path', { d: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z' }]);
const PAUSE = () => icon(['rect', { x: 6, y: 5, width: 4, height: 14, rx: 1 }], ['rect', { x: 14, y: 5, width: 4, height: 14, rx: 1 }]);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let ctx = null; // { id, getMeeting, getSettings, onTranscriptChanged, say }
let kept = []; // metadata of the kept recording, [{ seq, t0, dur, bytes }]
export const hasAudio = () => kept.length > 0;

export async function initExtras(c) {
  ctx = c;
  try {
    kept = await listSegs(ctx.id);
  } catch {
    kept = [];
  }
  addEventListener('pagehide', () => closePlayer(false));
  // another page (the Open actions page) can tick an action while this one is open: show it, and never save a stale copy over it
  chrome.storage?.onChanged?.addListener((ch) => {
    const c2 = ch[`meeting:${ctx.id}`];
    if (!c2?.newValue?.items) return;
    const m = ctx.getMeeting();
    if (m && JSON.stringify(m.items) !== JSON.stringify(c2.newValue.items)) {
      m.items = c2.newValue.items;
      paintActions();
    }
  });
}

// ---- 1. play a line ------------------------------------------------------------------------------------------------

const rowData = new WeakMap(); // transcript row element -> its data
let bar = null;
let audio = null;
let objUrl = '';
let cur = null; // the stored segment that is loaded: { seq, t0, dur }
let absNow = 0; // the second of the meeting that is playing (or was asked for)
let token = 0; // a newer request makes an older one give up
let opener = null;
let userScrolled = false;
let markedRow = null;
let rowTimes = null;

const MISSING = 'No recording was kept for this part.';

export function timeButton(sec, label, cls, text = label) {
  const b = el('button', { type: 'button', className: cls, textContent: text });
  b.setAttribute('aria-label', `Play from ${label}`);
  b.onclick = () => playFrom(sec, b);
  return b;
}

function ensureBar() {
  if (bar) return bar;
  audio = el('audio', { className: 'pb-audio', preload: 'auto' });
  audio.id = 'momAudio';
  const play = el('button', { type: 'button', className: 'pb-play' });
  play.append(PLAY());
  play.setAttribute('aria-label', 'Pause');
  const time = el('span', { className: 'pb-time', textContent: '00:00' });
  const back = el('button', { type: 'button', className: 'pb-back', textContent: 'Back 10 s' });
  back.setAttribute('aria-label', 'Back 10 seconds');
  const again = el('button', { type: 'button', className: 'pb-again', textContent: 'Read again' });
  again.setAttribute('aria-label', 'Read this part again');
  again.hidden = true;
  const close = el('button', { type: 'button', className: 'pb-close' });
  close.append(icon(['path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', fill: 'none' }]));
  close.setAttribute('aria-label', 'Close the player');
  const msg = el('span', { className: 'pb-msg' });
  msg.setAttribute('role', 'status');
  bar = el('div', { className: 'playbar no-print', hidden: true }, play, time, el('span', { className: 'pb-grow' }), back, again, close, msg, audio);
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Recording player');
  bar.id = 'playBar';
  document.body.append(bar);

  const paintPlay = () => {
    const paused = audio.paused;
    play.replaceChildren(paused ? PLAY() : PAUSE());
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  };
  audio.addEventListener('play', paintPlay);
  audio.addEventListener('pause', paintPlay);
  audio.addEventListener('timeupdate', () => {
    if (!cur) return;
    absNow = cur.t0 + audio.currentTime;
    time.textContent = fmtTime(absNow);
    markRow(absNow, true);
  });
  audio.addEventListener('ended', () => advance());
  audio.addEventListener('error', () => {
    if (audio.getAttribute('src')) say('This part could not be played.');
  });
  play.onclick = () => {
    if (audio.getAttribute('src') && !audio.ended) audio.paused ? audio.play().catch(() => say('This part could not be played.')) : audio.pause();
    else start(absNow);
  };
  back.onclick = () => start(Math.max(0, absNow - 10));
  again.onclick = () => {
    const r = markedRow && rowData.get(markedRow);
    if (r) openReread(L.rereadSpan(r), again);
    else say('Press play on a line first.');
  };
  close.onclick = () => closePlayer(true);
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePlayer(true);
    }
  });
  for (const ev of ['wheel', 'touchmove']) addEventListener(ev, () => (userScrolled = true), { passive: true });
  addEventListener('keydown', (e) => ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key) && !bar.contains(e.target) && (userScrolled = true));
  return bar;
}

function say(text) {
  if (bar) bar.querySelector('.pb-msg').textContent = text;
  bar?.classList.toggle('has-msg', !!text);
}

export async function playFrom(sec, trigger) {
  ensureBar();
  bar.hidden = false;
  document.body.classList.add('has-playbar');
  opener = trigger || opener;
  userScrolled = false;
  await start(sec);
}

async function start(sec) {
  const mine = ++token;
  absNow = sec;
  bar.querySelector('.pb-time').textContent = fmtTime(sec);
  markRow(sec, false);
  let seg = null;
  try {
    seg = await segAt(ctx.id, sec);
  } catch {}
  if (mine !== token) return;
  if (!seg) {
    stopAudio();
    say(MISSING);
    return;
  }
  load(seg, Math.max(0, sec - seg.t0));
}

function stopAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = '';
  cur = null;
}

function load(seg, offset) {
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = URL.createObjectURL(seg.blob);
  cur = { seq: seg.seq, t0: seg.t0, dur: seg.dur };
  Object.assign(audio.dataset, { seq: seg.seq, t0: seg.t0, offset });
  say('');
  audio.src = objUrl;
  audio.addEventListener(
    'loadedmetadata',
    () => {
      try {
        if (offset > 0) audio.currentTime = offset;
      } catch {}
      audio.play().catch(() => say('This part could not be played. Press play.'));
    },
    { once: true }
  );
}

// the stored segments are 30 s each: carry on into the next one until paused or the recording ends
async function advance() {
  const mine = ++token;
  const next = cur && L.nextSeg(kept, cur);
  if (!next) {
    say('That is the end of the recording.');
    return;
  }
  if (next.gap) {
    say(MISSING);
    return;
  }
  let seg = null;
  try {
    seg = await segAt(ctx.id, next.seg.t0 + 0.01);
  } catch {}
  if (mine !== token) return;
  if (!seg) return say(MISSING);
  load(seg, next.offset);
}

export function closePlayer(refocus) {
  if (!bar || bar.hidden) return;
  token++;
  stopAudio();
  bar.hidden = true;
  say('');
  document.body.classList.remove('has-playbar');
  markRow(null);
  if (refocus && opener && document.contains(opener) && !opener.disabled) opener.focus();
}

// the transcript line that is playing
function markRow(sec, follow = false) {
  if (sec == null) {
    markedRow?.removeAttribute('aria-current');
    markedRow = null;
    return;
  }
  // the rows are looked up once per render (transcriptRendered() clears this), not on every timeupdate
  if (!rowTimes || !rowTimes.rows[0]?.isConnected) {
    const found = [...document.querySelectorAll('#transcript .seg[data-play]')];
    rowTimes = { rows: found, times: found.map((r) => Number(r.dataset.t)) };
  }
  const rows = rowTimes.rows;
  if (!rows.length) {
    markedRow?.removeAttribute('aria-current');
    markedRow = null;
    return;
  }
  const i = L.rowIndexAt(rowTimes.times, sec);
  const row = i >= 0 ? rows[i] : null;
  if (row === markedRow) return;
  markedRow?.removeAttribute('aria-current');
  markedRow = row;
  row?.setAttribute('aria-current', 'true');
  const again = bar?.querySelector('.pb-again');
  if (again) again.hidden = !row || rowData.get(row)?.src === 'screen';
  // keep the line in view, unless the person has scrolled away since pressing play
  if (follow && row && !userScrolled && $('trTab') && !$('trTab').classList.contains('hidden')) {
    const b = row.getBoundingClientRect();
    const barTop = bar.getBoundingClientRect().top;
    if (b.top < 80 || b.bottom > barTop - 8) row.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }
}

// "[12:40]" inside the rendered minutes becomes a button that plays from there (only when a recording was kept)
export function decorateTimes(root) {
  if (!hasAudio() || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('button, a, code, pre, .act-tick') || !L.timeTokens(n.nodeValue).length ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const text = n.nodeValue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const t of L.timeTokens(text)) {
      if (t.index > at) frag.append(text.slice(at, t.index));
      frag.append(timeButton(t.sec, t.label, 'timebtn', `[${t.label}]`));
      at = t.index + t.length;
    }
    if (at < text.length) frag.append(text.slice(at));
    n.replaceWith(frag);
  }
}

// A transcript row: its time becomes the play control, a gap gets "Read this part again".
export function decorateRow(row, r) {
  rowData.set(row, r);
  if (!hasAudio() || r.src === 'note') {
    if (hasAudio()) row.children[0].classList.add('t-flat'); // no play control here: its digits line up with the ones that have it
    if (r.gap && hasAudio()) addGapButton(row, r);
    return;
  }
  row.dataset.play = '1';
  row.dataset.t = String(r.t);
  row.children[0].replaceChildren(timeButton(r.t, fmtTime(r.t), 'seg-play'));
}
function addGapButton(row, r) {
  const b = el('button', { type: 'button', className: 'rr-gap', textContent: 'Read this part again' });
  b.setAttribute('aria-label', `Read this part again, ${fmtTime(r.gap.from)} to ${fmtTime(r.gap.to)}`);
  b.onclick = () => openReread(L.rereadSpan(r), b);
  row.children[2].append(el('div', { className: 'rr-wrap' }, b));
}

export function transcriptRendered() {
  rowTimes = null;
  markedRow = null;
  if (bar && !bar.hidden) markRow(absNow, false);
}

// the quiet line that says how to get playback (once)
const HINT_KEY = 'db.mom.keepHint';
const hintSeen = () => {
  try {
    return !!localStorage.getItem(HINT_KEY);
  } catch {
    return false;
  }
};
const hintMark = () => {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {}
};
export function paintKeepHint(settings) {
  const box = $('keepHint');
  if (!box) return;
  const show = !hasAudio() && !settings.keepAudio && !hintSeen();
  box.classList.toggle('hidden', !show);
  if (show && !box.dataset.ready) {
    box.dataset.ready = '1';
    $('keepHintX').onclick = () => {
      hintMark();
      box.classList.add('hidden');
    };
  }
}
// called when the Transcript tab is shown: from then on it counts as seen
export function transcriptShown() {
  if (!$('keepHint')?.classList.contains('hidden')) hintMark();
}

// ---- 2. read a stretch again -----------------------------------------------------------------------------------------

let rereadBusy = false;

function openReread([from, to], trigger) {
  if (rereadBusy) return;
  const m = ctx.getMeeting();
  const settings = ctx.getSettings();
  const old = L.linesInSpan(m.segments, from, to).sort((a, b) => a.t - b.t);
  const nowText = old.length ? old.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join('\n\n') : 'Nothing was written for this part.';
  const dlg = el('dialog', { className: 'dbmodal rr-dialog' });
  dlg.setAttribute('aria-labelledby', 'rrTitle');
  const title = el('h2', { id: 'rrTitle', textContent: 'Read this part again' });
  const sub = el('p', { className: 'hint', textContent: `From ${fmtTime(from)} to ${fmtTime(to)}. The recording of this part is sent to your speech-to-text service again.` });
  const colNow = el('div', { className: 'rr-col' }, el('h3', { textContent: 'Now' }), el('div', { className: 'rr-text', textContent: nowText, tabIndex: 0 }));
  const outText = el('div', { className: 'rr-text', textContent: 'Reading the recording…', tabIndex: 0 });
  outText.setAttribute('role', 'status');
  const colNew = el('div', { className: 'rr-col' }, el('h3', { textContent: 'Read again' }), outText);
  colNow.querySelector('.rr-text').setAttribute('aria-label', 'The lines now');
  outText.setAttribute('aria-label', 'The text read again');
  const err = el('p', { className: 'rr-err hidden' });
  err.setAttribute('role', 'alert');
  const keep = el('button', { type: 'button', textContent: 'Keep what I have' });
  const retry = el('button', { type: 'button', textContent: 'Try again', hidden: true });
  const replace = el('button', { type: 'button', className: 'primary', textContent: 'Replace these lines', disabled: true });
  const btns = el('div', { className: 'dbbtns rr-btns' }, keep, retry, replace);
  dlg.append(title, sub, el('div', { className: 'rr-cols' }, colNow, colNew), err, btns);
  document.body.append(dlg);

  let cancelled = false;
  let fresh = null;
  const done = () => {
    cancelled = true;
    dlg.close();
    dlg.remove();
    if (trigger && document.contains(trigger) && !trigger.disabled) trigger.focus();
  };
  keep.onclick = done;
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    done();
  });

  const run = async () => {
    cancelled = false;
    fresh = null;
    err.classList.add('hidden');
    retry.hidden = true;
    replace.disabled = true;
    outText.textContent = 'Reading the recording…';
    rereadBusy = true;
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    try {
      const got = await readAgain(from, to, settings, (i, n) => !cancelled && (outText.textContent = n > 1 ? `Reading part ${i} of ${n}…` : 'Reading the recording…'), () => cancelled);
      if (cancelled) return;
      fresh = L.freshLines({ ...got, to, old });
      outText.textContent = fresh.length ? fresh.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join('\n\n') : 'Nothing was heard in this part.';
      replace.disabled = !fresh.length;
      if (fresh.length) replace.focus();
    } catch (e) {
      if (cancelled) return;
      outText.textContent = 'Nothing was read.';
      err.textContent = e?.message ? `${e.message}` : 'The recording could not be read.';
      err.classList.remove('hidden');
      retry.hidden = false;
      retry.focus();
    } finally {
      rereadBusy = false;
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
    }
  };
  retry.onclick = run;
  replace.onclick = async () => {
    if (!fresh?.length) return;
    replace.disabled = true;
    try {
      await applyReplace(from, to, fresh);
      done();
      ctx.say('Lines replaced. Press Rewrite minutes to use the new text.');
    } catch (e) {
      err.textContent = `The lines were not changed: ${e.message}`;
      err.classList.remove('hidden');
      replace.disabled = false;
    }
  };
  dlg.showModal();
  keep.focus();
  if (!sttReady(settings)) {
    outText.textContent = 'Nothing was read.';
    err.textContent = 'Set up speech to text in Settings first.';
    err.classList.remove('hidden');
    return;
  }
  run();
}

// The audio of from..to, as 16 kHz mono, sent in parts of at most a minute. -> { utterances, text, from }
async function readAgain(from, to, settings, progress, stopped) {
  const blobs = await segRange(ctx.id, from, to);
  if (!blobs.length) throw new Error(MISSING);
  const SR = 16000;
  const base = blobs[0].t0;
  const real = Math.max(from, base);
  // on the recording's timeline: a stretch that was not kept (a pause) is silence, so every time below is the real one
  const pcm = await pcm16kRange(blobs, real, to, { AudioContextCtor: window.AudioContext, OfflineCtor: window.OfflineAudioContext });
  if (!pcm) throw new Error('The recording could not be read in this browser.');
  const spans = L.splitSpan(real, to);
  const parts = [];
  for (let i = 0; i < spans.length; i++) {
    if (stopped()) return {};
    progress(i + 1, spans.length);
    const [a, b] = spans[i];
    const slice = pcm.subarray(Math.max(0, Math.round((a - real) * SR)), Math.min(pcm.length, Math.round((b - real) * SR)));
    if (slice.length < SR * 0.5) continue;
    parts.push({ at: a, end: b, result: await transcribeDetailed(encodeWav(slice, SR), settings) });
  }
  const utterances = L.mergeParts(parts, real, (p) => p.end);
  return { utterances, from: real };
}

async function applyReplace(from, to, fresh) {
  const latest = await getMeeting(ctx.id);
  if (!latest) throw new Error('The meeting is no longer stored.');
  const next = L.replaceLines(latest.segments, from, to, fresh);
  if (!(await replaceMeetingList(ctx.id, 'segments', next))) throw new Error('The meeting is no longer stored.');
  const gaps = L.gapsOutside(latest.gaps, from, to);
  if (gaps.length !== (latest.gaps || []).length) await replaceMeetingList(ctx.id, 'gaps', gaps);
  const again = await getMeeting(ctx.id); // a copy that knows what is stored, so a later save of the page's copy cannot undo this
  const m = ctx.getMeeting();
  Object.assign(m, { segments: again.segments, gaps: again.gaps });
  ctx.onTranscriptChanged();
}

// ---- 3. actions you can tick ---------------------------------------------------------------------------------------

let actionRoot = null;
const actionBox = { rows: [], line: null };

function bodyRows(table) {
  return [...table.rows].filter((tr) => tr.querySelector('td'));
}

export function decorateActions(root) {
  actionBox.rows = [];
  actionBox.line = null;
  actionRoot = null;
  const m = ctx.getMeeting();
  const actions = m?.items?.actions;
  if (!root || !m.mom || !Array.isArray(actions) || !actions.length) return;
  const found = [];
  let heading = '';
  for (const n of root.querySelectorAll('h1, h2, h3, h4, table')) {
    if (n.tagName === 'TABLE') found.push({ el: n, heading, rows: bodyRows(n).map((tr) => [...tr.cells].map((c) => c.textContent)) });
    else heading = n.textContent;
  }
  const hit = L.matchActionTable(found, actions);
  if (!hit) return;
  const table = found[hit.table].el;
  actionRoot = root;
  const rows = bodyRows(table);
  rows.forEach((tr, i) => {
    const cell = tr.cells[hit.col];
    const id = actions[i].id;
    if (!cell || !id) return;
    cell.classList.add('act-cell');
    const text = el('span', { className: 'act-text' });
    text.append(...cell.childNodes);
    const cb = el('input', { type: 'checkbox' });
    const name = el('span', { className: 'sr-only', textContent: `Mark done: ${actions[i].text}` });
    const label = el('label', { className: 'act-tick no-print' }, cb, name);
    const status = el('span', { className: 'sr-only act-status' });
    cell.append(label, text, status);
    cb.onchange = () => toggle(id, cb);
    actionBox.rows.push({ tr, cb, status, id, text });
  });
  const live = el('span', { className: 'sr-only', id: 'actLive' });
  live.setAttribute('role', 'status');
  const count = el('span', { className: 'act-count' });
  const link = el('a', { href: 'actions.html', textContent: 'All open actions' });
  actionBox.line = el('p', { className: 'act-summary no-print' }, count, ' ', link, live);
  actionBox.count = count;
  actionBox.live = live;
  (table.closest('.tablewrap') || table).before(actionBox.line);
  paintActions();
}

function paintActions() {
  const m = ctx.getMeeting();
  if (!actionBox.line || !actionRoot || !document.contains(actionBox.line)) return;
  const byId = new Map((m.items?.actions || []).map((a) => [a.id, a]));
  for (const r of actionBox.rows) {
    const a = byId.get(r.id);
    const done = a?.status === 'done';
    r.cb.checked = done;
    r.tr.classList.toggle('act-done', done);
    // when the minutes text already says "(done)", the screen reader has heard it
    r.status.textContent = done && !/\(done\)\s*$/i.test(r.text.textContent) ? ' (done)' : '';
  }
  const c = L.actionCounts(m.items?.actions);
  actionBox.count.textContent = `${c.open} open · ${c.done} done`;
}

async function toggle(id, cb) {
  const want = cb.checked;
  const m = ctx.getMeeting();
  const a = (m.items?.actions || []).find((x) => x.id === id);
  cb.disabled = true;
  try {
    if (!(await setActionDone(m.id, id, want))) throw new Error('this action is no longer in the meeting');
    // take what is stored (doneAt and the like) so a later save of this page's copy keeps the tick
    const meta = await getMeetingMeta(m.id, { counts: [] });
    if (meta?.items) m.items = meta.items;
    else if (a) a.status = want ? 'done' : 'open';
    paintActions();
    actionBox.live.textContent = `${want ? 'Marked done' : 'Marked open again'}: ${a?.text || ''}`;
  } catch (e) {
    cb.checked = !want;
    actionBox.live.textContent = `Could not save the change: ${e.message}`;
  } finally {
    cb.disabled = false;
  }
}

// What the minutes view gets after every render.
export function afterMinutes(root) {
  decorateTimes(root);
  decorateActions(root);
}

// ---- 4. carried actions, 5. screen notes, 6. warnings ----------------------------------------------------------------

export function paintCarried(meeting) {
  const box = $('carried');
  if (!box) return;
  const from = meeting.carriedFrom;
  const ok = from && typeof from.id === 'string' && from.id;
  box.classList.toggle('hidden', !ok);
  if (!ok) return;
  const when = Number.isFinite(from.at) ? fmtDay(from.at) : '';
  const a = el('a', { href: `mom.html?id=${encodeURIComponent(from.id)}`, textContent: [from.title || 'an earlier meeting', when].filter(Boolean).join(', ') });
  box.replaceChildren('Reviews open actions from ', a);
}

// A transcript row for a note about the shared screen: quieter than speech, and not nameable.
export function paintScreenRow(row, r) {
  row.classList.add('screen');
  row.children[1].className = 'who screen';
  row.children[1].textContent = 'On screen';
  row.children[2].replaceChildren(...(r.presenter ? [el('span', { className: 'by', textContent: `Shared by ${r.presenter}` })] : []), r.text);
  row.dataset.play = '1';
  row.dataset.t = String(r.t);
  rowData.set(row, r);
  if (hasAudio()) row.children[0].replaceChildren(timeButton(r.t, fmtTime(r.t), 'seg-play'));
}

// Lines for the warning box besides the transcription problems.
export function extraWarnings(m) {
  const out = [];
  if (m.webhookError) out.push(`Could not send the minutes to your other tool: ${m.webhookError}`);
  if (m.notice && m.notice.ok === false) out.push(`The recording notice could not be posted in the meeting chat${m.notice.why ? ` (${m.notice.why})` : ''}.`);
  return out;
}

export const transcriptFile = (lines, m) => L.addScreenLines(lines, m.screens).join('\n');

// ---- 7. export ---------------------------------------------------------------------------------------------------------

export async function exportJson(m) {
  const data = await exportMeeting(m.id); // without the voice fingerprints
  if (!data) throw new Error('The meeting is no longer stored.');
  return { name: L.safeFileName(m.title, m.startedAt, 'json'), text: JSON.stringify(data, null, 2) };
}
