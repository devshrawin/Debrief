// Small controller window that lives outside the Meet page: mute/unmute your mic in the transcript,
// watch levels and alerts, and stop, without covering the meeting.
// Elements are cached up front: when the controls move into a Picture-in-Picture window,
// document.getElementById on this page no longer finds them.
const cache = {};
const $ = (id) => (cache[id] ||= document.getElementById(id));
['rec', 'stateWord', 'time', 'idle', 'live', 'eq', 'mic', 'micSub', 'tabB', 'tabT', 'micB', 'micT', 'alert', 'alertT', 'alertD', 'pip', 'stop', 'app'].forEach($);
const send = (msg) => chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => null);

const MIC_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>';

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
};
const word = (v) => (v == null ? 'off' : v < 0.003 ? 'silent' : v < 0.012 ? 'quiet' : 'good');
function meter(barId, textId, v) {
  const b = $(barId);
  b.style.width = v == null ? '0%' : `${Math.min(100, Math.round(Math.sqrt(v) * 160))}%`;
  b.className = v != null && v < 0.003 ? 'dead' : v != null && v < 0.012 ? 'low' : '';
  $(textId).textContent = word(v);
}

let S = { rec: { recording: false } };

function render() {
  const rec = S.rec;
  const on = rec.recording && !rec.stopping;
  $('rec').classList.toggle('idle', !on);
  $('stateWord').textContent = rec.stopping ? 'finishing…' : on ? 'recording' : 'idle';
  $('time').textContent = on ? fmt((Date.now() - rec.startedAt) / 1000) : '';
  $('idle').classList.toggle('hidden', on);
  $('live').classList.toggle('hidden', !on);
  $('eq').classList.toggle('hidden', !on);
  if (!on) return;

  const lv = S.levels;
  const fresh = lv && Date.now() - lv.at < 4000;
  $('eq').classList.toggle('live', !!fresh && Math.max(lv.tab || 0, lv.mic || 0) >= 0.012);
  $('eq').classList.toggle('dead', !fresh);

  const wanted = !!(rec.micWanted ?? rec.micOn);
  const paused = wanted && !rec.micOn;
  const mic = $('mic');
  mic.className = 'mic ' + (!rec.mic ? 'off' : paused ? 'paused' : wanted ? 'on' : 'off');
  mic.innerHTML = (wanted && !paused ? MIC_ON : MIC_OFF) + (!rec.mic ? 'No mic' : paused ? 'Muted in Meet' : wanted ? 'Mic on' : 'Mic off');
  mic.disabled = !rec.mic;
  $('micSub').textContent = !rec.mic
    ? 'Microphone is not available to Debrief'
    : paused
      ? 'Meet is muted, so your voice is skipped. Click to turn it off.'
      : wanted
        ? 'Your voice goes into the transcript. Click to ignore it.'
        : 'Your voice is ignored. Click to include it.';

  meter('tabB', 'tabT', fresh ? lv.tab : null);
  meter('micB', 'micT', fresh && rec.micOn ? lv.mic : null);

  const a = rec.alert;
  $('alert').classList.toggle('hidden', !a);
  if (a) {
    $('alert').className = `alert ${a.kind}`;
    $('alertT').textContent = `⚠ ${a.title}`;
    $('alertD').textContent = a.detail;
  }
}

async function load() {
  const r = await send({ type: 'pill-state' });
  if (r?.ok) S = r;
  render();
}

$('mic').onclick = async () => {
  await send({ type: 'mic', on: !(S.rec.micWanted ?? S.rec.micOn) });
  load();
};
$('stop').onclick = () => send({ type: 'stop' });

// Document Picture-in-Picture gives a window that stays above every other app. It needs a click to open.
$('pip').onclick = async () => {
  const api = window.documentPictureInPicture;
  if (!api) {
    $('pip').textContent = 'Not supported';
    return;
  }
  try {
    const app = $('app');
    const pip = await api.requestWindow({ width: 320, height: 250 });
    const style = document.querySelector('style');
    pip.document.head.append(style.cloneNode(true));
    pip.document.body.append(app);
    document.body.textContent = 'Controls are floating on top. Close that window to bring them back here.';
    pip.addEventListener('pagehide', () => {
      document.body.textContent = '';
      document.body.append(app);
    });
  } catch (e) {
    $('pip').textContent = 'Could not pin';
  }
};

load();
setInterval(load, 700);
