// The live page: the transcript as it arrives, a summary so far, and questions, while the meeting is still going on.
// It only looks. Pause and stop stay in the popup and the pill.
// Lines come from the background's broadcast AND from re-reading the stored meeting every few seconds, so the page is
// right even when every broadcast is missed or the service worker restarts.
import { getSettings, llmReady, getMeeting, getMeetingMeta, getState, fmtTime } from './store.js';
import { parseDictionary } from './dictionary.js';
import { modelLabel } from './llm.js';
import { generateWithRetry } from './jobs.js';
import { parseStructured, renderMinutes } from './structured.js';
import { renderMd, decorateMinutes } from './md.js';
import { mountAsk } from './askui.js';
import { LiveStore, MIN_WORDS, POLL_MS, fromContentScript, needsReread, pollOver, continues, reduceState, chipText, latencyNote, atBottom, summaryPrompt, summaryAt, provisionalLabel } from './livelogic.js';

const $ = (id) => document.getElementById(id);
const BATCH = 150; // rows drawn per step when a long meeting is first opened
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = new URLSearchParams(location.search).get('id') || '';
let settings = {};
let store = new LiveStore();
let state = { phase: 'unknown', startedAt: null };
let broadcast = null; // the last 'state' message
let rec = null; // the background's own answer
let meta = null;
let pollTimer = null;
let finished = false; // the meeting ended and its last read is done

// ---- the transcript on screen ----
const log = $('log');
const els = new Map(); // row key -> element
let next = 0; // rows[0..next) are on screen
let pumping = false;
let following = true; // true while the reader is at the bottom

function makeRow(row, prev) {
  const el = h('div', row.kind === 'screen' ? 'lv-line screen' : 'lv-line');
  const t = h('span', 't', fmtTime(row.t));
  if (row.kind === 'screen') {
    el.append(t, h('span', 'text', `On screen${row.presenter ? ` (${row.presenter})` : ''}: ${row.text}`));
  } else {
    el.append(t, h('span', `who ${row.src}`, row.who), h('span', 'text', row.text));
    if (continues(prev, row)) el.classList.add('cont');
  }
  els.set(row.key, el);
  return el;
}

// The page is the only scroller: following the transcript means being at the bottom of the window.
const scroller = () => document.scrollingElement || document.documentElement;
const toBottom = () => {
  scroller().scrollTop = scroller().scrollHeight;
  following = true;
  $('newLines').classList.add('hidden');
};

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const end = Math.min(store.rows.length, next + BATCH);
    if (end > next) $('empty')?.remove();
    const frag = document.createDocumentFragment();
    for (let i = next; i < end; i++) frag.append(makeRow(store.rows[i], store.rows[i - 1]));
    next = end;
    log.append(frag);
    if (following) scroller().scrollTop = scroller().scrollHeight;
    else if (end > 0) $('newLines').classList.remove('hidden');
    if (next < store.rows.length) setTimeout(step, 0);
    else pumping = false;
  };
  step();
}

// fresh: [{ index, row }] from LiveStore.add. A line that belongs before what is already drawn is put in its place.
function show(fresh) {
  for (const { index, row } of fresh) {
    if (index < next) {
      $('empty')?.remove();
      const before = els.get(store.rows[index + 1].key);
      log.insertBefore(makeRow(row, store.rows[index - 1]), before);
      next++;
      const after = store.rows[index + 1];
      els.get(after.key)?.classList.toggle('cont', continues(row, after));
      if (!following) $('newLines').classList.remove('hidden');
    }
  }
  pump();
  syncControls();
}

window.addEventListener('scroll', () => {
  following = atBottom(scroller());
  if (following) $('newLines').classList.add('hidden');
});
$('newLines').onclick = () => {
  toBottom();
  log.focus({ preventScroll: true });
};

function take(m) {
  if (!m) return;
  show([...store.add('segment', m.segments), ...store.add('screen', m.screens)]);
  store.markRead(m);
  syncControls();
}

// ---- header: title, state chip ----
const tickChip = () => {
  const chip = $('chip');
  const p = state.phase;
  chip.className = `badge lv-chip ${p === 'recording' ? 'rec' : p === 'paused' ? 'warn' : ''}`;
  $('chipDot').classList.toggle('hidden', p !== 'recording');
  $('chipText').textContent = chipText(state);
};
let shownPhase = '';
function setState() {
  state = reduceState({ id, broadcast, rec, meta, prev: state });
  tickChip();
  if (state.phase !== shownPhase) {
    if (shownPhase) $('stateNote').textContent = chipText({ ...state, startedAt: null }).replace(/ · .*/, '');
    shownPhase = state.phase;
  }
  $('minutesLink').classList.toggle('hidden', state.phase !== 'ended');
  $('minutesLink').href = `mom.html?id=${encodeURIComponent(id)}`;
  syncControls();
}

// Once the meeting is over, "Open minutes" is the next step: it is the primary button, and the summary-so-far button and the
// note about pieces of text (which is about a running meeting) step back. A summary needs enough words to be worth asking for.
function syncControls() {
  const ended = state.phase === 'ended';
  $('minutesLink').classList.toggle('primary', ended);
  $('sumGo').classList.toggle('primary', !ended);
  for (const x of ['latency', 'latencyHint']) $(x).classList.toggle('hidden', ended || !$(x).textContent);
  if (!id) return;
  const enough = store.wordCount() >= MIN_WORDS;
  $('sumGo').disabled = !!sumAbort || !(enough || ended);
  $('sumGo').title = enough || ended ? '' : 'Available once there is a little more to summarise.';
}

function setEmpty(text) {
  const e = $('empty');
  if (e) e.textContent = text;
}

// ---- talking to the background, which may not be there ----
const bg = (msg) =>
  Promise.race([chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => null), sleep(2500).then(() => null)]);

async function liveState() {
  const r = await bg({ type: 'live-state' });
  return r?.ok ? r : null;
}

// ---- one look at what is stored ----
let pulling = false;
async function pull() {
  if (!id || pulling) return;
  pulling = true;
  try {
    meta = await getMeetingMeta(id, { counts: ['segments', 'screens'] }).catch(() => null);
    if (!meta) {
      setEmpty('This meeting is not on this computer.');
      return;
    }
    store.opts.room = !!meta.room;
    $('mtitle').textContent = meta.title || 'Untitled meeting';
    document.title = `Live · ${meta.title || 'Meeting'} · Debrief`;
    // more stored than the last read held: read it again and merge (the merge drops what the broadcast already showed)
    if (needsReread(meta.counts, store.seen)) take(await getMeeting(id));
    if (!store.rows.length) setEmpty('Waiting for the first piece of speech…');
    const r = await liveState();
    if (r) rec = r.rec || null;
    setState();
    // the meeting is over: one last read of what is stored (the last pieces may have been written after the last look), then no more polling
    if (pollOver(state) && !finished) {
      finished = true;
      clearInterval(pollTimer);
      take(await getMeeting(id));
    }
  } finally {
    pulling = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (fromContentScript(sender, chrome.runtime.getURL(''))) return; // a web page's script must not feed this page
  if (msg?.target !== 'live' || msg.type !== 'live') return;
  if (!id && msg.meetingId) {
    location.replace(`live.html?id=${encodeURIComponent(msg.meetingId)}`);
    return;
  }
  if (msg.meetingId !== id || !msg.item) return;
  if (msg.kind === 'segment') show(store.addBroadcast('segment', [msg.item]));
  else if (msg.kind === 'screen') show(store.addBroadcast('screen', [msg.item]));
  else if (msg.kind === 'state') {
    broadcast = msg.item;
    // the push is newer than the last poll's answer about this recording: it wins until the next poll
    if (rec && rec.meetingId === id) rec = { ...rec, recording: msg.item.recording !== false, paused: !!msg.item.paused };
    setState();
  }
});

// ---- summary so far ----
let sumAbort = null;
const sumKey = () => `live-sum:${id}`;
function showSummary(md, at) {
  $('sumOut').classList.remove('hidden');
  $('sumLabel').textContent = provisionalLabel(at);
  $('sumBody').innerHTML = renderMd(md); // sanitised by the renderer; the text came from the model
  decorateMinutes($('sumBody')); // action tables stack to fit the column; others scroll sideways inside their own box
  chipTimes($('sumBody'));
}
// "[12:40]" in the summary looks like it does in the minutes: a small time chip (plain text; the page does not play audio)
function chipTimes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]/.test(n.nodeValue) && !n.parentElement.closest('code, pre')) nodes.push(n);
  for (const n of nodes) {
    const parts = n.nodeValue.split(/(\[(?:\d{1,2}:)?\d{1,2}:\d{2}\])/);
    n.replaceWith(...parts.filter(Boolean).map((x) => (/^\[.*\]$/.test(x) ? h('span', 'timechip', x) : document.createTextNode(x))));
  }
}
function setStatus(text, busy) {
  const s = $('sumStatus');
  s.replaceChildren();
  if (busy) s.append(h('span', 'spin', ''), ' ');
  s.append(text);
}
const noModelNotice = (box) => {
  box.classList.remove('hidden');
  box.replaceChildren();
  const d = h('div');
  d.append(h('strong', null, 'Set up a model in Settings first'), h('p', null, 'Summaries and answers use the same service as your minutes. None is set up yet.'));
  const b = h('button', null, 'Open Settings');
  b.onclick = () => (chrome.runtime?.openOptionsPage ? chrome.runtime.openOptionsPage() : window.open('options.html'));
  box.append(d, b);
};

async function summarise() {
  if (sumAbort) return;
  settings = await getSettings();
  $('sumNotice').classList.add('hidden');
  if (!llmReady(settings)) return noModelNotice($('sumNotice'));
  // read what is stored right now: the broadcast may have missed lines
  try {
    take(await getMeeting(id));
  } catch {}
  const m = (await getMeetingMeta(id, { counts: [] }).catch(() => null)) || meta || { id };
  const p = summaryPrompt({ meeting: { ...m, id }, rows: store.rows, settings });
  if (!p.ok) return setStatus(p.reason, false);
  const at = summaryAt(state, store.lastT);
  sumAbort = new AbortController();
  $('sumGo').disabled = true;
  $('sumStop').classList.remove('hidden');
  $('sumStop').onclick = () => sumAbort?.abort();
  setStatus('Reading what has been said…', true);
  try {
    const text = await generateWithRetry({
      settings, system: p.system, user: p.user, signal: sumAbort.signal, json: true,
      onRetry: (n, e, wait) => setStatus(`Busy (${String(e.message).slice(0, 60)}). Trying again in ${wait} s…`, true),
    });
    const items = parseStructured(text);
    const md = items ? renderMinutes(items, { meeting: { title: m.title, startedAt: m.startedAt }, evidence: true }) : String(text || '').trim();
    if (!md) throw new Error('The model returned an empty reply. Try again.');
    showSummary(md, at);
    try {
      sessionStorage.setItem(sumKey(), JSON.stringify({ md, at }));
    } catch {}
    setStatus('', false);
  } catch (e) {
    setStatus(sumAbort.signal.aborted ? 'Stopped.' : `Could not write the summary: ${e.message}`, false);
  } finally {
    sumAbort = null;
    $('sumGo').disabled = false;
    syncControls();
    $('sumStop').classList.add('hidden');
  }
}
$('sumGo').onclick = summarise;

// ---- start ----
async function start() {
  settings = await getSettings();
  const lat = latencyNote(settings);
  $('latency').textContent = lat.text;
  $('latencyHint').textContent = lat.hint;
  $('latencyHint').classList.toggle('hidden', !lat.hint);
  const head = document.querySelector('.lv-head');
  if (head && window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--lv-head', `${head.offsetHeight}px`)).observe(head);
  store = new LiveStore({ myName: settings.myName });
  if (llmReady(settings)) $('privacy').textContent = `Your question and the transcript so far go to ${modelLabel(settings)}, the model you chose for the minutes. No audio is sent. Answers can be wrong.`;

  if (!id) {
    const r = await liveState();
    rec = r?.rec || null;
    id = (rec?.recording && (rec.meetingId || r.meetingId)) || '';
    if (!id) {
      const st = await getState().catch(() => null);
      if (st?.recording && st.meetingId) id = st.meetingId;
    }
    if (id) history.replaceState(null, '', `live.html?id=${encodeURIComponent(id)}`);
  }
  if (!id) {
    $('chip').classList.add('hidden');
    const e = $('empty');
    e.textContent = 'Nothing is being recorded right now. ';
    const a = h('a', null, 'Search your meetings');
    a.href = 'ask.html';
    e.append(a, '.');
    for (const x of ['sumGo']) $(x).disabled = true;
    mountAsk($('askBox'), { getMeetings: async () => [], getCtx: () => ({}), placeholder: 'Nothing is being recorded' });
    $('askBox').querySelector('input').disabled = true;
    $('askBox').querySelector('.primary').disabled = true;
    return;
  }

  $('minutesLink').href = `mom.html?id=${encodeURIComponent(id)}`;
  try {
    const c = JSON.parse(sessionStorage.getItem(sumKey()) || 'null');
    if (c?.md) showSummary(c.md, c.at);
  } catch {}

  mountAsk($('askBox'), {
    // the transcript as it stands at the moment of the question
    getMeetings: async () => {
      const m = await getMeeting(id);
      if (m) take(m);
      return m ? [m] : [];
    },
    getCtx: () => ({ entries: parseDictionary(settings.dictionary), attendees: [], learned: (settings.learnedNames || []).slice(-40), myName: settings.myName, room: !!meta?.room }),
    placeholder: 'e.g. "What has been decided so far?"',
    suggestions: ['What has been decided so far?', 'What action items have come up?', 'Who said what about the budget?', 'Summarise the last ten minutes'],
  });

  await pull();
  pollTimer = setInterval(() => {
    if (!document.hidden) pull();
  }, POLL_MS);
  setInterval(() => {
    if (!document.hidden) tickChip();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pull();
  });
}
start();
