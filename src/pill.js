// On-page recording pill for Google Meet: shows recording status and lets you switch your mic
// in or out of the transcript. Lives in a shadow root so Meet's CSS can't touch it.
import { adapterFor } from './adapters/index.js';

(() => {
  if (window.__debriefPill) return;
  const app = adapterFor(location.hostname);
  window.__debriefPill = true;

  const POS_KEY = 'debrief.pill.pos';
  // Solid dark surface (tokens from docs/redesign/Pill.dc.html) so it reads on any video or page background.
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Google Sans", "Segoe UI", system-ui, "Nirmala UI", "Kartika", sans-serif; }
    .wrap { position:relative; color:#eceef2; font-size:13px; line-height:1.4; pointer-events:none; }
    .wrap > * { pointer-events:auto; }
    button { font:inherit; }
    :focus-visible { outline:2px solid #b9b4ff; outline-offset:2px; }
    .sr { position:absolute; width:1px; height:1px; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; padding:0; }
    .hidden { display:none !important; }

    /* Capsule */
    .pill { display:flex; align-items:center; gap:10px; height:36px; padding:0 4px 0 12px; border-radius:999px;
      background:#16171c; border:1px solid rgba(255,255,255,.16); box-shadow:0 6px 20px -6px rgba(0,0,0,.55);
      color:#fff; font-size:13px; font-weight:600; line-height:1; cursor:grab; user-select:none; white-space:nowrap; touch-action:none; }
    .pill.dragging { cursor:grabbing; transform:rotate(-2deg) scale(1.04); box-shadow:0 16px 30px -8px rgba(0,0,0,.8); outline:2px solid #b9b4ff; outline-offset:2px; }
    .pill.alert { border-color:#ff9a4d; }
    .rd { width:9px; height:9px; border-radius:50%; background:#ff5a4e; flex:none; animation:rd 1.6s ease-out infinite; }
    .pill.silent .rd { animation:none; }
    @keyframes rd { 0% { box-shadow:0 0 0 0 rgba(255,90,78,.6); } 70% { box-shadow:0 0 0 6px rgba(255,90,78,0); } 100% { box-shadow:0 0 0 0 rgba(255,90,78,0); } }
    .eq { display:flex; gap:2px; align-items:center; height:16px; }
    .eq i { display:block; width:3px; height:5px; border-radius:2px; background:#cfccff; }
    .eq.live i { animation:eq .9s ease-in-out infinite; }
    .eq.live i:nth-child(2) { animation-delay:-.3s; } .eq.live i:nth-child(3) { animation-delay:-.6s; } .eq.live i:nth-child(4) { animation-delay:-.15s; }
    @keyframes eq { 0%,100% { height:4px; } 50% { height:15px; } }
    .silentmsg { font-size:12.5px; color:#ffd3a3; }
    .time { font-variant-numeric:tabular-nums; letter-spacing:.01em; }
    .warn-chip { display:none; padding:0 8px; border-radius:999px; background:#5a3610; color:#ffd3a3; font-size:11.5px; line-height:20px; }
    .warn-chip.show { display:inline-block; }

    .mic { height:28px; padding:0 10px 0 8px; border-radius:999px; border:0; display:inline-flex; align-items:center; gap:6px;
      font-size:12.5px; font-weight:700; cursor:pointer; }
    .mic svg { width:14px; height:14px; flex:none; }
    .mic:active { transform:scale(.97); }
    .mic:disabled { opacity:.55; cursor:default; transform:none; }
    .mic.on { background:#1f5a37; color:#c9f3d8; }
    .mic.off { background:#33353c; color:#d3d6dc; }
    .mic.muted { background:#5a3610; color:#ffd3a3; }

    /* Panel: floats beside the capsule so opening it never moves the capsule */
    .panel { position:absolute; right:0; top:calc(100% + 8px); width:260px; padding:14px; border-radius:14px;
      background:#16171c; border:1px solid rgba(255,255,255,.16); box-shadow:0 18px 40px -12px rgba(0,0,0,.7);
      display:flex; flex-direction:column; gap:12px; color:#eceef2; font-size:13px; font-weight:400; }
    .wrap.up .panel { top:auto; bottom:calc(100% + 8px); }
    .top { display:flex; justify-content:space-between; gap:8px; margin-bottom:3px; }
    .top .w { font-weight:700; }
    .m { height:6px; border-radius:9px; background:#2b2d34; overflow:hidden; }
    .m > i { display:block; height:100%; border-radius:9px; background:#6fd49a; transition:width .3s; }
    .m > i.q { background:#ff9a4d; }
    .line { margin:0; color:#b8bcc6; }
    .note { position:relative; padding:10px 12px; border-radius:10px; background:#3a2610; border:1px solid #6b4a1c; color:#ffd3a3; line-height:1.45; }
    .note strong { display:block; padding-right:18px; }
    .x { position:absolute; top:4px; right:4px; width:22px; height:22px; border:0; border-radius:6px; background:transparent; color:#ffd3a3; font-size:16px; line-height:1; cursor:pointer; }
    .x:hover { background:rgba(255,255,255,.1); }
    .row { display:flex; align-items:center; gap:10px; }
    .grow { flex:1; font-weight:600; }
    .psw { width:40px; height:24px; border-radius:999px; border:0; padding:0; background:#4a4f58; position:relative; cursor:pointer; flex:none; }
    .psw::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:transform .15s; }
    .psw[aria-checked="true"] { background:#9d97ff; }
    .psw[aria-checked="true"]::after { transform:translateX(16px); }
    .psw:disabled { opacity:.5; cursor:default; }
    .stop { min-height:40px; width:100%; border-radius:10px; border:0; background:#ff5a4e; color:#2a0705; font-weight:700;
      display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; }
    .stop:hover { background:#ff7066; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation:none !important; transition:none !important; }
      .eq i { height:9px; }
      .pill.dragging { transform:none; }
    }
  `;
  const MIC_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>';

  // After the extension is reloaded or updated, this script is orphaned: chrome.runtime throws
  // "Extension context invalidated" (synchronously, so .catch alone misses it). Clean up quietly.
  let timer = null;
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  function shutdown() {
    clearInterval(timer);
    host?.remove();
    window.__debriefPill = false;
  }
  const send = async (msg) => {
    if (!alive()) {
      shutdown();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage({ target: 'bg', ...msg });
    } catch {
      if (!alive()) shutdown();
      return null;
    }
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

  // null = could not tell. The page readers live in adapters/ (Meet has its own, other sites share a generic one).
  const meetMuted = () => (app.id === 'generic' && !app.inCall(document) ? null : app.micButton(document)?.muted ?? null);

  let myTab = null;
  let S = { rec: { recording: false }, levels: null, counts: { segs: 0, errs: 0 }, follow: true };
  let host;
  let wrap;
  let pill;
  let eq;
  let silentMsg;
  let timeEl;
  let micBtn;
  let warnChip;
  let panel;
  let status;
  let expanded = false;
  let lastSentMute;
  let panelSig = '';
  let lastStatus = '';

  async function load() {
    const r = await send({ type: 'pill-state' });
    if (r?.ok) S = r;
  }

  // The panel floats beside the capsule (absolute), so opening it never moves the capsule. It opens
  // downward while the capsule is in the upper half of the window and upward otherwise.
  function flip() {
    if (!host || !wrap) return;
    const r = host.getBoundingClientRect();
    wrap.classList.toggle('up', r.top + r.height / 2 > innerHeight / 2);
  }
  // Keep the capsule on screen after a resize.
  function clampIn() {
    if (!host || host.style.display === 'none') return;
    const r = host.getBoundingClientRect();
    if (!r.width) return;
    if (r.right > innerWidth || r.left < 0) host.style.right = Math.max(0, Math.min(innerWidth - r.width, innerWidth - r.right)) + 'px';
    if (r.bottom > innerHeight || r.top < 0) host.style.bottom = Math.max(0, Math.min(innerHeight - r.height, innerHeight - r.bottom)) + 'px';
    flip();
  }

  function setExpanded(v) {
    if (expanded === v) return;
    expanded = v;
    panelSig = '';
    render();
  }

  function mount() {
    host = document.createElement('div');
    host.setAttribute('data-debrief', '');
    // Default: top right, well clear of the meeting's own toolbar at the bottom.
    let pos = { right: 18, bottom: Math.max(92, innerHeight - 18 - 36) };
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY));
      if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) pos = p;
    } catch {}
    host.style.cssText = `position:fixed;right:${pos.right}px;bottom:${pos.bottom}px;z-index:2147483646;display:none;pointer-events:none;`;
    // Closed, so the meeting page's own scripts cannot reach in and press Stop or read the alerts.
    const root = host.attachShadow({ mode: 'closed' });
    host.__debriefRoot = root; // an expando is invisible to page scripts; the tests read it
    const style = el('style');
    style.textContent = CSS;
    wrap = el('div', 'wrap');
    panel = el('div', 'panel hidden');
    panel.id = 'dbPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Recording details');
    panel.tabIndex = -1;
    pill = el('div', 'pill');
    pill.setAttribute('role', 'button');
    pill.tabIndex = 0;
    pill.setAttribute('aria-expanded', 'false');
    pill.setAttribute('aria-controls', 'dbPanel');
    status = el('span', 'sr');
    status.setAttribute('role', 'status');
    const dot = el('span', 'rd');
    dot.setAttribute('aria-hidden', 'true');
    eq = el('span', 'eq');
    eq.setAttribute('aria-hidden', 'true');
    eq.append(el('i'), el('i'), el('i'), el('i'));
    silentMsg = el('span', 'silentmsg hidden', 'No audio is arriving');
    timeEl = el('span', 'time', '00:00');
    warnChip = el('span', 'warn-chip');
    micBtn = el('button', 'mic');
    micBtn.type = 'button';
    pill.append(dot, eq, silentMsg, timeEl, warnChip, micBtn);
    wrap.append(status, panel, pill);
    root.append(style, wrap);
    document.documentElement.appendChild(host);

    micBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    micBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ type: 'mic', on: !(S.rec.micWanted ?? S.rec.micOn) });
      await load();
      render();
    });
    pill.addEventListener('keydown', (e) => {
      if (e.target !== pill) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setExpanded(!expanded);
      }
    });
    drag(pill);
    // The panel belongs to a click: a click elsewhere on the page, or Escape, closes it again.
    document.addEventListener('pointerdown', (e) => {
      if (expanded && !e.composedPath().includes(host)) setExpanded(false);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (expanded && e.key === 'Escape') {
        setExpanded(false);
        pill.focus();
      }
    }, true);
    // Full screen: the pill follows the page into it (an element outside the full-screen element is not drawn),
    // and goes back afterwards. A <video> cannot hold children, so then the pill simply stays where it was.
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      const home = fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME' ? fs : document.documentElement;
      if (host.parentNode !== home) home.appendChild(host);
      clampIn();
    });
    addEventListener('resize', clampIn);
    flip();
  }

  function drag(target) {
    let st = null;
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = host.getBoundingClientRect();
      st = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
      try {
        target.setPointerCapture(e.pointerId);
      } catch {}
    });
    target.addEventListener('pointermove', (e) => {
      if (!st) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (!st.moved && Math.hypot(dx, dy) < 4) return;
      if (!st.moved) pill.classList.add('dragging');
      st.moved = true;
      host.style.right = Math.max(0, Math.min(innerWidth - 60, st.right - dx)) + 'px';
      host.style.bottom = Math.max(0, Math.min(innerHeight - 36, st.bottom - dy)) + 'px';
      flip();
    });
    target.addEventListener('pointerup', () => {
      if (!st) return;
      pill.classList.remove('dragging');
      if (st.moved) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ right: parseInt(host.style.right, 10), bottom: parseInt(host.style.bottom, 10) }));
        } catch {}
      } else {
        setExpanded(!expanded);
      }
      st = null;
    });
    target.addEventListener('pointercancel', () => {
      pill.classList.remove('dragging');
      st = null;
    });
  }

  const label = (v) => (v == null ? 'Off' : v < 0.003 ? 'Silent' : v < 0.012 ? 'Very quiet' : 'Good');
  function meter(name, v, text) {
    const box = el('div', 'meter');
    const top = el('div', 'top');
    const word = text || label(v);
    top.append(el('span', null, name), el('span', 'w', word));
    const b = el('div', 'm');
    const pct = v == null ? 0 : Math.min(100, Math.round(Math.sqrt(v) * 160));
    b.setAttribute('role', 'meter');
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-valuemin', '0');
    b.setAttribute('aria-valuemax', '100');
    b.setAttribute('aria-valuenow', String(pct));
    b.setAttribute('aria-valuetext', word);
    const f = el('i', v != null && v < 0.012 ? 'q' : '');
    f.style.width = pct + '%';
    b.append(f);
    box.append(top, b);
    return box;
  }

  const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2.5" fill="currentColor"></rect></svg>';

  function render() {
    if (!host) return;
    const rec = S.rec;
    const mine = rec.recording && !rec.stopping && rec.tabId === myTab;
    host.style.display = mine && S.showPill ? '' : 'none';
    if (!mine || !S.showPill) return;

    timeEl.textContent = fmt((Date.now() - rec.startedAt) / 1000);
    const lv = S.levels;
    const fresh = lv && Date.now() - lv.at < 4000;
    const peak = fresh ? Math.max(lv.tab || 0, lv.mic || 0) : 0;
    eq.classList.toggle('live', peak >= 0.012);
    eq.classList.toggle('hidden', !fresh);
    silentMsg.classList.toggle('hidden', !!fresh);
    pill.classList.toggle('silent', !fresh);
    const alert = rec.alert;
    warnChip.classList.toggle('show', !!alert);
    warnChip.textContent = alert?.kind === 'key' ? 'API key' : 'Limit';

    const wanted = rec.micWanted ?? rec.micOn;
    const paused = wanted && !rec.micOn;
    micBtn.className = 'mic ' + (!rec.mic ? 'off' : paused ? 'muted' : wanted ? 'on' : 'off');
    micBtn.innerHTML = (wanted && !paused ? MIC_ON : MIC_OFF) + (!rec.mic ? 'No mic' : paused ? 'Muted in call' : wanted ? 'Mic on' : 'Mic off');
    micBtn.disabled = !rec.mic;
    const micTitle = !rec.mic
      ? 'Microphone not available to Debrief'
      : paused
        ? 'You are muted in the call, so Debrief is ignoring your mic. Click to stop including it.'
        : wanted
          ? 'Your mic is in the transcript. Click to ignore it.'
          : 'Your mic is ignored. Click to include it.';
    micBtn.title = micTitle;
    micBtn.setAttribute('aria-label', 'Microphone: ' + micBtn.textContent.trim() + '. ' + (rec.mic ? 'Click to change' : 'Not available'));

    pill.setAttribute('aria-expanded', String(expanded));
    pill.classList.toggle('open', expanded);
    pill.setAttribute('aria-label', `Debrief recording, ${timeEl.textContent}. ${expanded ? 'Hide' : 'Show'} details`);
    // Announce only changes of state, never the ticking timer.
    const say = alert ? alert.title : !fresh ? 'No audio is arriving' : paused ? 'You are muted in the call' : 'Debrief is recording';
    if (say !== lastStatus) {
      lastStatus = say;
      status.textContent = say;
    }
    pill.classList.toggle('alert', !fresh);

    panel.classList.toggle('hidden', !expanded);
    if (!expanded) {
      panelSig = '';
      return;
    }
    // Rebuild the card only when something visible changed, so clicks are never swallowed.
    const sig = JSON.stringify([peak > 0 ? Math.round(lv.tab * 1000) : 0, fresh && rec.micOn ? Math.round((lv.mic || 0) * 1000) : -1, S.counts, alert?.at, !!fresh, !!rec.mic, !!wanted, !!paused]);
    if (sig === panelSig) return;
    panelSig = sig;
    const active = panel.getRootNode().activeElement;
    const keep = active && panel.contains(active) ? active.dataset.k : null;
    panel.replaceChildren();
    panel.append(meter('Meeting audio', fresh ? lv.tab : null));
    if (!rec.mic) panel.append(meter('Your mic', null, 'Unavailable'));
    else if (paused) panel.append(meter('Your mic', 0.001, 'Paused'));
    else if (!wanted) panel.append(meter('Your mic', null, 'Ignored'));
    else panel.append(meter('Your mic', fresh ? lv.mic : null));
    const line = !rec.mic
      ? "Debrief can't reach your microphone. The call is still recorded."
      : paused
        ? 'You are muted in the call, so Debrief pauses your mic.'
        : wanted
          ? 'Your voice is going into the transcript.'
          : 'Your mic is not recorded. The call still is.';
    panel.append(el('p', 'line', line));
    panel.append(el('p', 'line', `${S.counts.segs} pieces transcribed · ${S.counts.errs} ${S.counts.errs === 1 ? 'error' : 'errors'}`));
    if (!fresh) {
      const box = el('div', 'note');
      box.setAttribute('role', 'alert');
      box.append(el('strong', null, 'No audio is arriving'), 'If this stays, stop and start the recording again.');
      panel.append(box);
    }
    if (alert) {
      const box = el('div', 'note');
      box.setAttribute('role', 'alert');
      const x = el('button', 'x', '×');
      x.type = 'button';
      x.dataset.k = 'dismiss';
      x.title = 'Dismiss';
      x.setAttribute('aria-label', 'Dismiss alert');
      x.onclick = async () => {
        await send({ type: 'dismiss-alert' });
        await load();
        render();
      };
      box.append(x, el('strong', null, alert.title), alert.detail || '');
      panel.append(box);
    }
    const row = el('div', 'row');
    const sw = el('button', 'psw');
    sw.type = 'button';
    sw.dataset.k = 'mic';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!wanted));
    sw.setAttribute('aria-label', 'Include my microphone');
    sw.disabled = !rec.mic;
    sw.onclick = async () => {
      await send({ type: 'mic', on: !(S.rec.micWanted ?? S.rec.micOn) });
      await load();
      render();
    };
    row.append(el('span', 'grow', 'Include my microphone'), sw);
    panel.append(row);
    const stop = el('button', 'stop');
    stop.type = 'button';
    stop.dataset.k = 'stop';
    stop.innerHTML = STOP_ICON + 'Stop and write minutes';
    stop.onclick = () => send({ type: 'stop' });
    panel.append(stop);
    if (keep) panel.querySelector(`[data-k="${keep}"]`)?.focus();
  }

  function reportMute() {
    if (!S.rec.recording || S.rec.tabId !== myTab) {
      lastSentMute = undefined;
      return;
    }
    const m = meetMuted();
    if (m !== lastSentMute) {
      lastSentMute = m;
      send({ type: 'meet-mute', muted: m });
    }
  }

  // Watches for Meet's "you left / the meeting ended" screens while this tab is being recorded.
  let endedHits = 0;
  function checkEnded() {
    if (!S.rec.recording || S.rec.stopping || S.rec.tabId !== myTab) {
      endedHits = 0;
      return;
    }
    endedHits = app.endScreen(document) ? endedHits + 1 : 0;
    // Two checks in a row (about 2 s) so a flicker during a screen change can't stop a live meeting.
    if (endedHits === 2 || (endedHits > 2 && endedHits % 30 === 0)) send({ type: 'meet-ended' });
  }

  // Who is in the call and who is speaking, sampled once per second but only sent when it changes.
  let lastPeople = '';
  let lastCaps = new Map();
  let captionTries = 0;
  function sampleMeeting() {
    if (!S.rec.recording || S.rec.stopping || S.rec.tabId !== myTab || !app.hasPeople) return;
    const mode = S.captionMode || 'read';
    const t = Math.max(0, (Date.now() - S.rec.startedAt) / 1000);
    const people = app.readParticipants(document);
    const key = people.join('|');
    const payload = {};
    if (key !== lastPeople) {
      lastPeople = key;
      payload.names = people;
    }
    if (mode !== 'off') {
      if (mode === 'auto' && captionTries < 3 && !app.captionsRegion(document)) {
        const btn = app.captionsButton(document);
        if (btn) {
          captionTries++;
          btn.click();
        }
      }
      const fresh = [];
      for (const c of app.readCaptions(document)) {
        if (lastCaps.get(c.name) !== c.text) {
          lastCaps.set(c.name, c.text);
          fresh.push({ name: String(c.name).slice(0, 60), text: String(c.text).slice(0, 600), t });
        }
      }
      if (fresh.length) payload.captions = fresh;
    }
    if (payload.names || payload.captions) send({ type: 'meet-snap', t, ...payload });
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.target === 'page' && msg.type === 'diagnose') {
      try {
        reply({ ok: true, diag: app.diagnose(document), site: app.name });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    }
  });

  // Tells the extension when this tab has a live call, so its icon can glow amber as a reminder to record.
  let lastInCall;
  function reportCall() {
    const on = !!app.inCall(document);
    if (on !== lastInCall) {
      lastInCall = on;
      send({ type: 'in-call', on, site: app.name });
    }
  }

  async function tick() {
    if (!alive()) return shutdown();
    await load();
    render();
    // Other meeting apps can be switched off in Settings; Google Meet always works.
    if (app.id === 'generic' && S.otherSites === false) return;
    reportMute();
    checkEnded();
    sampleMeeting();
    reportCall();
  }

  async function init() {
    // A host left by an orphaned copy of this script (after an extension reload) must not linger.
    document.querySelectorAll('[data-debrief]').forEach((n) => n.remove());
    const r = await send({ type: 'whoami' });
    myTab = r?.tabId ?? null;
    mount();
    await tick();
    timer = setInterval(tick, 1000);
  }
  init();
})();
