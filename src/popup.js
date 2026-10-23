import { nearLimit, parseLimits, quotaCheck } from './usage.js';
import { isMeetingSite, platformHint } from './adapters/index.js';
import { roomFor, modeHint, isMeetingUrl } from './room.js';
import { getSettings, sttReady, llmReady, getState, getMeeting, listMeetings, deleteMeeting, fmtTime } from './store.js';

const $ = (id) => document.getElementById(id);

// Opened inside the floating panel on a web page (src/panel.js), the popup is an iframe: it cannot close itself, so it asks
// the panel, and it tells the panel when it is ready and how tall it is.
const framed = window.top !== window;
const tell = (m) => { if (framed) window.parent.postMessage({ debriefPanel: true, ...m }, '*'); };
const closePanel = () => (framed ? tell({ type: 'close' }) : window.close());
if (framed) {
  tell({ type: 'ready' });
  const size = () => tell({ type: 'size', h: Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)) });
  new ResizeObserver(size).observe(document.body);
  for (const ms of [150, 600, 1500]) setTimeout(size, ms); // content that arrives after the first paint
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') tell({ type: 'close' }); });
}
const send = (msg) => chrome.runtime.sendMessage({ target: 'bg', ...msg });
const show = (id, on) => $(id).classList.toggle('hidden', !on);

const levelWord = (v) => (v == null ? 'Off' : v < 0.003 ? 'Silent' : v < 0.012 ? 'Quiet' : 'Good');
function setMeter(barId, textId, v) {
  const bar = $(barId);
  bar.style.width = v == null ? '0%' : `${Math.min(100, Math.round(Math.sqrt(v) * 160))}%`;
  bar.className = v != null && v < 0.003 ? 's' : v != null && v < 0.012 ? 'q' : '';
  $(textId).textContent = levelWord(v);
}

const pieces = (n) => `${n} transcript piece${n === 1 ? '' : 's'}`;
function whenOf(m) {
  const d = new Date(m.startedAt);
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  if (!m.endedAt) return day;
  const min = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000));
  return `${day} · ${min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`}`;
}
const openMinutes = (id) => chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${id}`) });

async function refresh() {
  const st = await getState();
  const recording = st.recording && !st.stopping;
  show('idleView', !st.recording);
  show('recView', !!recording);
  show('finView', !!st.stopping);
  $('statusText').textContent = st.stopping ? 'Finishing transcription…' : st.recording ? (st.paused ? 'Paused' : st.room ? 'Recording the room' : 'Recording') : 'Idle';
  show('pause', !!recording);
  show('fullscreen', !!recording);
  $('pause').textContent = st.paused ? 'Resume recording' : 'Pause recording';
  $('pause').setAttribute('aria-pressed', String(!!st.paused));
  $('timer').textContent = st.recording ? fmtTime((Date.now() - st.startedAt) / 1000) : '';
  show('start', !st.recording);
  show('modeBox', !st.recording && !blockedTab);
  show('shortcutHint', !st.recording && !blockedTab);
  show('stop', !!recording);
  show('live', !!recording);
  show('micRow', !!(recording && st.mic));
  const wanted = !!(st.micWanted ?? st.micOn);
  $('micToggle').setAttribute('aria-checked', String(wanted));
  // Following the call's own mute button: say what Debrief sees, so a button it cannot find is not a mystery.
  $('micStateT').textContent = wanted && !st.micOn ? 'Paused: you are muted in the call' : wanted ? (st.meetMuted === false ? 'Your voice goes into the transcript (unmuted in the call)' : st.meetMuted == null ? 'Your voice goes into the transcript (the mute button in the call was not found, so your mic is always on)' : 'Your voice goes into the transcript') : 'Your voice is ignored';
  $('micState').className = `hint ${!wanted ? 'off' : !st.micOn ? 'paused' : st.meetMuted == null ? 'unknown' : ''}`;
  show('micWarn', !!(recording && st.micError));
  $('micWarn').textContent = st.micError ? `Only other participants are being recorded. ${st.micError}` : '';

  const a = recording ? st.alert : null;
  show('alert', !!a);
  if (a) {
    $('alertTitle').textContent = a.title;
    $('alertText').textContent = a.detail;
    show('alertActionRow', a.kind === 'key' || a.kind === 'quota');
  }

  const { levels } = await chrome.storage.session.get('levels');
  const fresh = st.recording && levels && Date.now() - levels.at < 4000;
  if (st.recording) {
    if (fresh) {
      setMeter('lvTab', 'lvTabT', levels.tab);
      setMeter('lvMic', 'lvMicT', st.micOn ? levels.mic : null);
    } else {
      setMeter('lvTab', 'lvTabT', null);
      setMeter('lvMic', 'lvMicT', null);
      $('lvTabT').textContent = 'No sound data: stop and restart';
    }
    const m = await getMeeting(st.meetingId);
    const n = m?.segments.length || 0;
    const errs = m?.errors.length || 0;
    const info = $('segInfo');
    const spans = [pieces(n), `${errs} error${errs === 1 ? '' : 's'}`];
    if (!n) spans.push('First one lands after about 2 to 3 min.');
    info.replaceChildren(...spans.map((t) => Object.assign(document.createElement('span'), { textContent: t })));
    info.title = errs ? 'Failed chunks are kept and can be retried from the minutes page.' : '';
    if (st.stopping) $('finInfo').textContent = `${pieces(n)} so far. Then the minutes are written, about 30 s. You can close this popup.`;
    $('finOpen').onclick = (e) => {
      e.preventDefault();
      openMinutes(st.meetingId);
    };
  }
}

async function usageWarning() {
  const { usage, learnedLimits = {} } = await chrome.storage.local.get(['usage', 'learnedLimits']);
  const settings = await getSettings();
  const hits = nearLimit(usage, { ...learnedLimits, ...parseLimits(settings.usageLimits) });
  show('usageWarn', !!hits.length);
  $('usageWarnText').textContent = hits.map((h) => `${h.model}: ${h.used} of ${h.limit} requests used today`).join(' · ') + '. Debrief will fall back to other models if one runs out.';
  // before recording: would a one-hour meeting fit in what is left of today's Gemini allowance?
  const q = quotaCheck(usage, { ...learnedLimits, ...parseLimits(settings.usageLimits) }, settings);
  const hidden = (await chrome.storage.local.get('quotaWarnHidden')).quotaWarnHidden === true; // the person closed it
  show('quotaWarn', !!q?.short && !hidden);
  if (q?.short) $('quotaWarnText').textContent = `A one-hour meeting needs about ${q.need} requests and ${q.left} are left today (${q.used} of ${q.limit} used). ${q.longHelps ? 'Choose "About 4 minutes (fewer requests)" in Settings → Speech to text to make it fit.' : 'Part of the meeting may be kept as audio to transcribe tomorrow.'}`;
}

$('quotaWarnX').onclick = async () => {
  await chrome.storage.local.set({ quotaWarnHidden: true });
  show('quotaWarn', false);
};

let armed = null;
let allMeetings = [];
const TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>';

function emptyState(title, hint) {
  const d = document.createElement('div');
  d.className = 'empty';
  const t = document.createElement('strong');
  t.textContent = title;
  const h = document.createElement('p');
  h.className = 'hint';
  h.style.margin = '0';
  h.textContent = hint;
  d.append(t, h);
  return d;
}

async function renderRecent() {
  allMeetings = await listMeetings();
  show('clearAll', !!allMeetings.length);
  $('meetCount').textContent = allMeetings.length;
  const last = allMeetings[0];
  show('lastBox', !!last);
  if (last) {
    $('lastTitle').textContent = last.title;
    $('lastTitle').title = last.title;
    $('lastWhen').textContent = whenOf(last);
    show('lastMail', !!last.emailedAt);
    $('lastOpen').onclick = (e) => {
      e.preventDefault();
      openMinutes(last.id);
    };
  }
  await drawList();
}

async function drawList() {
  const q = $('q').value.trim().toLowerCase();
  const items = allMeetings.filter((m) => !q || `${m.title} ${(m.attendees || []).join(' ')}`.toLowerCase().includes(q));
  if (!allMeetings.length) {
    $('recent').replaceChildren(emptyState('No meetings yet', 'Recorded meetings and their minutes appear here.'));
    return;
  }
  if (!items.length) {
    $('recent').replaceChildren(emptyState('No match', 'No meeting has that in its title or people.'));
    return;
  }
  const st = await getState();
  $('recent').replaceChildren(
    ...items.map((m) => {
      const row = document.createElement('div');
      row.className = `item${armed === m.id ? ' armed' : ''}`;
      const a = document.createElement('a');
      a.className = 'open';
      a.href = '#';
      const t = document.createElement('div');
      t.className = 't trunc';
      t.textContent = m.title;
      t.title = m.title;
      const meta = document.createElement('div');
      meta.className = 'm';
      meta.append(Object.assign(document.createElement('span'), { textContent: whenOf(m) }));
      if (m.emailedAt) meta.append(Object.assign(document.createElement('span'), { className: 'chip brand', textContent: 'Emailed' }));
      a.append(t, meta);
      a.onclick = (e) => {
        e.preventDefault();
        openMinutes(m.id);
      };
      row.append(a);
      const live = st.recording && st.meetingId === m.id;
      if (!live) {
        const del = document.createElement('button');
        if (armed === m.id) {
          del.className = 'confirm';
          del.textContent = 'Delete?';
          del.setAttribute('aria-label', `Confirm: delete ${m.title}`);
        } else {
          del.className = 'del';
          del.innerHTML = TRASH;
          del.title = 'Delete this meeting';
          del.setAttribute('aria-label', `Delete ${m.title}`);
        }
        del.onclick = async () => {
          if (armed !== m.id) {
            armed = m.id;
            await drawList();
            $('recent').querySelector('.confirm')?.focus();
            setTimeout(() => {
              if (armed === m.id) {
                armed = null;
                drawList();
              }
            }, 3000);
            return;
          }
          armed = null;
          await deleteMeeting(m.id);
          await renderRecent();
          $('q').focus();
        };
        row.append(del);
      }
      return row;
    })
  );
}

$('q').oninput = drawList;

function selectTab(b) {
  document.querySelectorAll('#tabs [role=tab]').forEach((x) => {
    x.setAttribute('aria-selected', String(x === b));
    x.tabIndex = x === b ? 0 : -1;
  });
  document.querySelectorAll('[role=tabpanel]').forEach((p) => (p.hidden = p.id !== b.dataset.pane));
}
document.querySelectorAll('#tabs [role=tab]').forEach((b) => {
  b.onclick = () => selectTab(b);
  b.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[i]);
    tabs[i].focus();
  };
});

$('clearAll').onclick = async () => {
  const b = $('clearAll');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.classList.add('armed');
    b.textContent = 'Click again to delete all';
    setTimeout(() => {
      b.dataset.armed = '';
      b.classList.remove('armed');
      b.textContent = 'Clear all';
    }, 3000);
    return;
  }
  const st = await getState();
  for (const m of await listMeetings()) if (!(st.recording && st.meetingId === m.id)) await deleteMeeting(m.id);
  b.dataset.armed = '';
  b.classList.remove('armed');
  b.textContent = 'Clear all';
  renderRecent();
};

// What Debrief can read from the current page (asks the page script). Null when it cannot answer.
async function readPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.tabs.sendMessage(tab.id, { target: 'page', type: 'diagnose' });
    return r?.ok ? r : null;
  } catch {
    return null;
  }
}

function renderDiag(r) {
  const box = $('diagResult');
  box.replaceChildren();
  const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
  if (!r) {
    box.append(span('full', 'Open a Meet (or enabled meeting site) tab and reload it once, then try again.'));
    return;
  }
  const d = r.diag || {};
  const row = (label, text, ok) => box.append(span('', label), span(`chip ${ok ? 'ok' : 'warn'}`, text));
  const mic = String(d.micButton || '');
  const micFound = /^found/i.test(mic);
  row('Mute button', micFound ? `Found · ${/unmuted/i.test(mic) ? 'unmuted' : 'muted'}` : 'Not found', micFound);
  const ppl = String(d.participants || '');
  const n = ppl.match(/^(\d+) found/);
  if (!/not read/i.test(ppl)) row('People list', n ? `${n[1]} name${n[1] === '1' ? '' : 's'}` : 'None found · open People', !!n);
  const capOn = /^region found/i.test(String(d.captions || ''));
  if (!/not read/i.test(String(d.captions || ''))) row('Captions', capOn ? 'On' : 'Off · turn on for names', capOn);
  box.append(span('hint full', `${r.site || 'This page'} · ${String(d.inCall || '')}`));
}

$('diagnose').onclick = async (e) => {
  e.preventDefault();
  const open = $('diagnose').getAttribute('aria-expanded') !== 'true';
  $('diagnose').setAttribute('aria-expanded', String(open));
  show('diagResult', open);
  if (!open) return;
  $('diagResult').textContent = 'Checking…';
  renderDiag(await readPage());
};

async function detectCall() {
  const r = await readPage();
  const inCall = /^yes/i.test(String(r?.diag?.inCall || ''));
  show('callBanner', inCall);
  if (inCall) $('callSite').textContent = `${r.site || 'Meeting'} · this tab`;
}

$('askAll').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('ask.html') });
};
$('askHome').onclick = $('askAll').onclick;

$('alertX').onclick = () => send({ type: 'dismiss-alert' }).then(refresh);
$('alertAction').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

// Online meeting or a room: decided by the tab's link, and the user can flip it before pressing Start.
let tabUrl = '';
let blockedTab = false; // a Chrome page: nothing can be recorded, so the start controls are hidden
let chosenRoom = null; // null = follow the link
const currentRoom = () => roomFor(tabUrl, chosenRoom);
function paintMode() {
  const room = currentRoom();
  $('modeOnline').setAttribute('aria-checked', String(!room));
  $('modeRoom').setAttribute('aria-checked', String(room));
  $('modeHint').textContent = modeHint(tabUrl, room, chosenRoom !== null && chosenRoom !== !isMeetingUrl(tabUrl));
  $('startLabel').textContent = room ? 'Start recording the room' : 'Start recording this tab';
}
for (const [id, value] of [['modeOnline', false], ['modeRoom', true]]) {
  $(id).onclick = () => {
    chosenRoom = value;
    paintMode();
  };
}

$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    show('error', false);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const r = await send({ type: 'start', streamId, tabId: tab.id, title: tab.title, url: tab.url, room: currentRoom() });
    if (!r?.ok) throw new Error(r?.error || 'unknown error');
  } catch (e) {
    $('error').textContent = `Could not start: ${e.message}`;
    show('error', true);
  } finally {
    $('start').disabled = false;
    refresh();
  }
};

$('fullscreen').onclick = async () => {
  await send({ type: 'window-fullscreen' });
  closePanel();
};

$('pause').onclick = async () => {
  $('pause').disabled = true;
  await send({ type: 'pause' });
  $('pause').disabled = false;
  refresh();
};

$('stop').onclick = async () => {
  $('stop').disabled = true;
  await send({ type: 'stop' });
  closePanel();
};

$('micToggle').onclick = () => {
  const on = $('micToggle').getAttribute('aria-checked') !== 'true';
  $('micToggle').setAttribute('aria-checked', String(on));
  send({ type: 'mic', on }).then(refresh);
};

for (const id of ['openTour', 'openTour1']) {
  $(id).onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?restart=1') });
  };
}

for (const id of ['openSettings', 'openSettings1']) {
  $(id).onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
}

(async () => {
  const s = await getSettings();
  const ready = sttReady(s) && llmReady(s);
  show('setup', !ready);
  const needGemini = (s.sttProvider === 'gemini' || s.llmProvider === 'gemini') && !s.geminiKey;
  $('setupMsg').textContent = needGemini ? 'Add your free Gemini key first.' : !sttReady(s) ? 'Add your speech-to-text key in Settings.' : 'Add your minutes writer key in Settings.';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const blocked = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(tab?.url || '');
  show('cantRecord', blocked);
  blockedTab = blocked;
  $('start').disabled = !sttReady(s) || blocked;
  let host = '';
  try {
    host = new URL(tab?.url || '').hostname;
  } catch {}
  tabUrl = tab?.url || '';
  paintMode();
  $('platformHint').textContent = platformHint(host);
  show('platformHint', !!platformHint(host));
  const syncOnline = () => show('offline', !navigator.onLine);
  syncOnline();
  addEventListener('online', syncOnline);
  addEventListener('offline', syncOnline);
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-recording');
  $('shortcutHint').innerHTML = cmd?.shortcut
    ? `Tell people you are recording. <kbd>${cmd.shortcut.split('+').join('</kbd>+<kbd>')}</kbd> also starts and stops, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> mutes your mic.`
    : 'Tell people you are recording. Set a start/stop shortcut at chrome://extensions/shortcuts.';
  await refresh();
  usageWarning();
  await renderRecent();
  if (isMeetingSite(host)) detectCall();
  setInterval(refresh, 1000);
})();
