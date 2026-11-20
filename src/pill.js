// On-page recording pill for Google Meet: shows recording status and lets you switch your mic
// in or out of the transcript. Lives in a shadow root so Meet's CSS can't touch it.
import { adapterFor } from './adapters/index.js';
import { noticeController, nudgeController, presentingReporter } from './adapters/pillrules.js';

(() => {
  if (window.__debriefPill) return;
  const app = adapterFor(location.hostname);
  window.__debriefPill = true;

  const POS_KEY = 'debrief.pill.pos';
  // Solid dark surface (tokens from docs/redesign/Pill.dc.html) so it reads on any video or page background.
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable", "Segoe UI", system-ui, "Nirmala UI", sans-serif; }
  /* Dark glass that reads over any video: a scrim plus blur, hairline edge, layered shadow */
  .wrap { --ink:#f5f5f7; --dim:#c7c7d1; --line:rgba(255,255,255,.14); --ok:#30d158; --warn:#ffb340; --bad:#ff6961; --tint:#a9a6ff;
    --glass: rgba(24,24,30,.86); --glass-thick: rgba(24,24,30,.95);
    display:flex; flex-direction:column; align-items:flex-end; gap:8px; color:var(--ink); -webkit-font-smoothing:antialiased;
    pointer-events:none; } /* the host and wrapper let clicks through to the page; only the pill and panel catch them */
  .wrap > * { pointer-events:auto; }

  .pill { position:relative; display:flex; align-items:center; gap:10px; min-height:40px; padding:4px 4px 4px 14px; border-radius:999px;
    background:var(--glass); -webkit-backdrop-filter:blur(20px) saturate(170%); backdrop-filter:blur(20px) saturate(170%);
    border:1px solid var(--line);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.10), 0 2px 6px rgba(0,0,0,.30), 0 14px 34px -12px rgba(0,0,0,.55);
    font-size:13px; font-weight:600; line-height:1; cursor:grab; user-select:none; white-space:nowrap; touch-action:none;
    transition: box-shadow .28s ease, border-color .28s ease; }
  .sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; } /* spoken to screen readers, never drawn */
  .pill:active { cursor:grabbing; }
  /* Calm breathing edge while recording (border-beam "pulse" idea, CSS only so nothing is injected into the page) */
  .pill::after { content:""; position:absolute; inset:-1px; border-radius:inherit; pointer-events:none;
    box-shadow:0 0 0 1px rgba(169,166,255,.0), 0 0 14px 0 rgba(169,166,255,.0); animation:breathe 3.2s ease-in-out infinite; }
  @keyframes breathe { 50% { box-shadow:0 0 0 1px rgba(169,166,255,.45), 0 0 16px 1px rgba(124,120,255,.28); } }
  .pill.alert { border-color:rgba(255,179,64,.65); }
  .pill.alert::after { animation:none; box-shadow:0 0 0 1px rgba(255,179,64,.35), 0 0 16px 1px rgba(255,159,10,.25); }

  .rec { width:8px; height:8px; border-radius:50%; background:var(--bad); box-shadow:0 0 0 0 rgba(255,105,97,.7); animation:ring 1.6s infinite; flex:none; }
  @keyframes ring { 70% { box-shadow:0 0 0 7px rgba(255,105,97,0); } 100% { box-shadow:0 0 0 0 rgba(255,105,97,0); } }
  .eq { display:flex; align-items:center; gap:2px; height:16px; }
  .eq i { display:block; width:3px; height:4px; border-radius:2px; background:var(--tint); }
  .eq.live i { animation:eq 900ms ease-in-out infinite; }
  .eq.live i:nth-child(2) { animation-delay:-.3s; } .eq.live i:nth-child(3) { animation-delay:-.6s; } .eq.live i:nth-child(4) { animation-delay:-.15s; }
  .eq.dead i { background:var(--warn); }
  @keyframes eq { 0%,100% { height:4px; } 50% { height:15px; } }
  .time { font-variant-numeric:tabular-nums; font-weight:650; letter-spacing:.01em; font-size:14px; }

  .warn-chip { display:none; align-items:center; gap:4px; padding:5px 9px; border-radius:999px; font-weight:650; font-size:11px;
    background:rgba(255,179,64,.16); color:#ffd59a; border:1px solid rgba(255,179,64,.45); }
  .warn-chip.show { display:inline-flex; }

  .mic { display:inline-flex; align-items:center; gap:6px; min-height:32px; font:inherit; font-size:12.5px; font-weight:650; cursor:pointer;
    border:1px solid transparent; border-radius:999px; padding:6px 12px 6px 9px; transition:transform .2s cubic-bezier(.2,.9,.3,1.2), background .2s; }
  .mic:hover { filter:brightness(1.08); } .mic:active { transform:scale(.95); }
  .pillx { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; margin-left:-2px; padding:0; border:0; border-radius:50%; background:transparent; color:var(--dim); font:inherit; font-size:17px; line-height:1; cursor:pointer; }
  .pillx:hover { background:rgba(255,255,255,.14); color:#fff; }
  .pillx:focus-visible { outline:none; box-shadow:0 0 0 3px rgba(169,166,255,.6); }
  .mic:focus-visible, .stop:focus-visible, .alertbox button:focus-visible, .switch:focus-within .track { outline:none; box-shadow:0 0 0 3px rgba(169,166,255,.6); }
  .mic:disabled { opacity:.5; cursor:default; }
  .mic svg { width:14px; height:14px; flex:none; }
  .mic.on { background:#30d158; color:#05210f; }
  .mic.off { background:rgba(255,255,255,.10); border-color:var(--line); color:var(--dim); }
  .mic.paused, .mic.muted { background:#ffb340; color:#241500; } /* mic held by the call mute: saffron, like the paused state */
  .toggle { display:flex; align-items:center; gap:10px; min-height:32px; margin:0; padding:0; border:0; border-radius:999px; background:none; color:inherit; font:inherit; line-height:1; cursor:inherit; white-space:nowrap; }
  .toggle:focus-visible { outline:none; box-shadow:0 0 0 3px rgba(169,166,255,.6); }

  .panel { width:288px; padding:14px 16px 16px; border-radius:20px; color:var(--ink);
    background:var(--glass-thick); -webkit-backdrop-filter:blur(36px) saturate(180%); backdrop-filter:blur(36px) saturate(180%);
    border:1px solid var(--line); box-shadow:inset 0 1px 0 rgba(255,255,255,.08), 0 8px 24px rgba(0,0,0,.4), 0 30px 70px -20px rgba(0,0,0,.7); font-size:12.5px;
    transform-origin: bottom right; animation: pop .28s cubic-bezier(.2,.9,.3,1.1); }
  @keyframes pop { from { opacity:0; transform:scale(.94) translateY(6px); } }
  .panel h4 { margin:0 0 10px; font-size:14px; font-weight:700; display:flex; align-items:center; gap:6px; }
  .panel h4 b { color:var(--tint); font-weight:700; }
  .meter { margin:8px 0 10px; }
  .meter .top { display:flex; justify-content:space-between; color:var(--dim); margin-bottom:5px; }
  .meter .top span:last-child { color:var(--ink); font-weight:600; }
  .bar { height:6px; border-radius:4px; background:rgba(255,255,255,.12); overflow:hidden; }
  .fill { height:100%; border-radius:4px; background:var(--ok); transition:width .3s; }
  .fill.low { background:var(--warn); } .fill.dead { background:var(--bad); }
  .stats { display:flex; gap:8px; margin:10px 0; }
  .stat { flex:1; padding:9px 10px; border-radius:12px; background:rgba(255,255,255,.07); border:1px solid var(--line); }
  .stat b { display:block; font-size:18px; font-weight:700; margin-bottom:2px; font-variant-numeric:tabular-nums; }
  .stat span { color:var(--dim); font-size:11px; }
  .stat.err b { color:var(--bad); }

  .alertbox { margin:10px 0; padding:10px 12px; border-radius:12px; background:rgba(255,105,97,.14); border:1px solid rgba(255,105,97,.45); }
  .alertbox.key { background:rgba(255,179,64,.12); border-color:rgba(255,179,64,.45); }
  .alertbox strong { display:flex; justify-content:space-between; align-items:center; font-size:12.5px; margin-bottom:4px; color:#ffc4bf; }
  .alertbox.key strong { color:#ffd59a; }
  .alertbox p { margin:0; color:#ececf2; font-size:12px; line-height:1.5; }
  .alertbox button { all:unset; cursor:pointer; color:var(--dim); font-size:16px; line-height:1; padding:4px 6px; border-radius:8px; }

  .switch { position:relative; display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:36px; margin:10px 0 2px; cursor:pointer; color:#ececf2; }
  .switch input { position:absolute; opacity:0; width:1px; height:1px; margin:0; }
  .track { position:relative; flex:none; width:40px; height:24px; border-radius:999px; background:rgba(255,255,255,.18); transition:background .25s; }
  .track::after { content:""; position:absolute; left:2px; top:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:transform .28s cubic-bezier(.2,.9,.3,1.15); box-shadow:0 2px 4px rgba(0,0,0,.35); }
  .switch input:checked + .track { background:var(--ok); } .switch input:checked + .track::after { transform:translateX(16px); }

  .stop { width:100%; min-height:40px; margin-top:12px; padding:9px; border-radius:12px; border:0; font:inherit; font-weight:700; font-size:13px; cursor:pointer;
    color:#2a0705; background:var(--bad); box-shadow:0 6px 16px -8px rgba(255,105,97,.8); }
  .stop:hover { filter:brightness(1.06); }
  .stop { display:flex; align-items:center; justify-content:center; gap:8px; }
  .stop svg { flex:none; }
  /* what the card is actually made of: a red dot, meter bars, plain lines, a note with a close button, the mic switch row */
  .rd { width:8px; height:8px; border-radius:50%; background:var(--bad); box-shadow:0 0 0 0 rgba(255,105,97,.7); animation:ring 1.6s infinite; flex:none; }
  .silentmsg { font-size:12px; font-weight:600; color:#ffd59a; }
  .meter .m { height:6px; border-radius:4px; background:rgba(255,255,255,.12); overflow:hidden; }
  .meter .m i { display:block; height:100%; border-radius:4px; background:var(--ok); transition:width .3s; }
  .meter .m i.q { background:var(--warn); }
  .line { margin:8px 0 0; color:var(--dim); font-size:12px; line-height:1.5; }
  .note { position:relative; margin:10px 0; padding:10px 36px 10px 12px; border-radius:12px; background:rgba(255,179,64,.12); border:1px solid rgba(255,179,64,.45); color:#ececf2; font-size:12px; line-height:1.5; }
  .note strong { display:block; margin-bottom:2px; color:#ffd59a; font-size:12.5px; }
  .note .x { all:unset; position:absolute; top:6px; right:6px; width:24px; height:24px; display:grid; place-items:center; cursor:pointer; color:var(--dim); font-size:16px; line-height:1; border-radius:8px; }
  .note .x:hover { background:rgba(255,255,255,.12); color:var(--ink); }
  .note .x:focus-visible, .psw:focus-visible { outline:none; box-shadow:0 0 0 3px rgba(169,166,255,.6); }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:40px; margin:12px 0 4px; }
  .row .grow { flex:1; min-width:0; color:#ececf2; font-size:12.5px; }
  .psw { all:unset; box-sizing:border-box; position:relative; flex:none; width:40px; height:24px; border-radius:999px; background:rgba(255,255,255,.18); cursor:pointer; transition:background .25s; }
  .psw::after { content:""; position:absolute; left:2px; top:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:transform .28s cubic-bezier(.2,.9,.3,1.15); box-shadow:0 2px 4px rgba(0,0,0,.35); }
  .psw[aria-checked="true"] { background:var(--ok); } .psw[aria-checked="true"]::after { transform:translateX(16px); }
  .psw:disabled { opacity:.5; cursor:default; }
  .hint { color:var(--dim); font-size:11.5px; margin-top:8px; line-height:1.45; }
  .hidden { display:none !important; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation:none !important; transition:none !important; } }
  @media (prefers-reduced-transparency: reduce) { .pill, .panel { -webkit-backdrop-filter:none; backdrop-filter:none; background:#1c1c22; } }
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
  const meetMuted = (call) => (app.id === 'generic' && !call ? null : app.micButton(document)?.muted ?? null);

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
  let closeBtn;
  let hiddenFor = null; // startedAt of the recording whose pill was closed with the cross
  let panel;
  let status;
  let expanded = false;
  let lastSentMute;
  let panelSig = '';
  let toggle; // the button inside the capsule that opens the details
  let discardArmed = false; // "Tap again" stays armed across rebuilds of the panel
  let discardTimer = 0;
  let lastStatus = '';
  let card; // the small card for the record reminder and for a recording notice that could not be posted
  let cardSig = '';
  let cardOn = false;
  let noticeAlert = null; // { text, until }
  const noticeCtl = noticeController();
  const nudgeCtl = nudgeController();
  const presentingRep = presentingReporter();
  const notified = new Set();

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
    card = el('div', 'alertbox key hidden');
    card.style.cssText = 'width:288px;margin:0';
    panel = el('div', 'panel hidden');
    panel.id = 'dbPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Recording details');
    panel.tabIndex = -1;
    // The capsule is a draggable box that holds two real buttons side by side: the one that opens the details, and the mic
    // switch. (The box itself is not a button: a button must not contain another.)
    pill = el('div', 'pill');
    toggle = el('button', 'toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'dbPanel');
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
    toggle.append(dot, eq, silentMsg, timeEl, warnChip);
    closeBtn = el('button', 'pillx', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Hide this pill');
    closeBtn.title = 'Hide this pill. The recording keeps going; stop it from the Debrief button on the toolbar.';
    pill.append(toggle, micBtn, closeBtn);
    wrap.append(status, card, panel, pill);
    root.append(style, wrap);
    document.documentElement.appendChild(host);

    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hiddenFor = S.rec.startedAt;
      expanded = false;
      render();
    });
    micBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    micBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ type: 'mic', on: !(S.rec.micWanted ?? S.rec.micOn) });
      await load();
      render();
    });
    // a mouse press is handled by the drag code on the capsule; only a keyboard press (click with no pointer: detail 0) toggles here
    toggle.addEventListener('click', (e) => {
      if (e.detail === 0) setExpanded(!expanded);
    });
    drag(pill);
    // The panel belongs to a click: a click elsewhere on the page, or Escape, closes it again.
    document.addEventListener('pointerdown', (e) => {
      if (expanded && !e.composedPath().includes(host)) setExpanded(false);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (expanded && e.key === 'Escape') {
        setExpanded(false);
        toggle.focus();
      }
    }, true);
    // Full screen: the pill follows the page into it (an element outside the full-screen element is not drawn),
    // and goes back afterwards. A <video> cannot hold children, so then the pill simply stays where it was.
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      const home = fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME' ? fs : document.documentElement;
      if (host.parentNode !== home) home.appendChild(host);
      clampIn();
      // While this tab is being recorded, Chrome may leave the window as it is when the page goes full screen, so the
      // window is taken full screen as well (and given back afterwards).
      if (S.rec?.recording && S.rec.tabId === myTab) send({ type: 'window-fullscreen', on: !!fs, auto: true });
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

  const label = (v) => (v == null ? 'Off' : v < 0.003 ? 'Silent' : v < 0.012 ? 'Quiet' : 'Good');
  // Draws one level into a meter that already exists (the meters are updated in place, so the panel is not rebuilt for them).
  function paintMeter(box, v, text) {
    const word = text || label(v);
    const pct = v == null ? 0 : Math.min(100, Math.round(Math.sqrt(v) * 160));
    const b = box.querySelector('.m');
    const f = b.querySelector('i');
    box.querySelector('.w').textContent = word;
    b.setAttribute('aria-valuenow', String(pct));
    b.setAttribute('aria-valuetext', word);
    f.className = v != null && v < 0.012 ? 'q' : '';
    f.style.width = pct + '%';
  }
  function meter(name, v, text) {
    const box = el('div', 'meter');
    const top = el('div', 'top');
    top.append(el('span', null, name), el('span', 'w'));
    const b = el('div', 'm');
    b.setAttribute('role', 'meter');
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-valuemin', '0');
    b.setAttribute('aria-valuemax', '100');
    b.append(el('i'));
    box.append(top, b);
    paintMeter(box, v, text);
    return box;
  }

  const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2.5" fill="currentColor"></rect></svg>';

  // The card: a question with two ways out (nudge), or one line that the notice could not be posted. Rebuilt only when it changes.
  function renderCard() {
    const mine = S.rec.recording && !S.rec.stopping && S.rec.tabId === myTab;
    if (noticeAlert && Date.now() > noticeAlert.until) noticeAlert = null;
    const want = noticeAlert ? { kind: 'notice', text: noticeAlert.text } : cardNudge && !S.rec.recording && !mine ? { kind: 'nudge', key: cardNudge.key, text: cardNudge.text } : null;
    cardOn = !!want;
    card.classList.toggle('hidden', !want);
    const sig = JSON.stringify(want);
    if (sig === cardSig) return;
    cardSig = sig;
    card.replaceChildren();
    if (!want) return;
    const btn = (label, css, onclick) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.style.cssText = css;
      b.addEventListener('click', onclick);
      return b;
    };
    const pillBtn = 'all:unset;cursor:pointer;font:inherit;font-size:12px;font-weight:650;color:var(--ink);padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.10)';
    const link = 'all:unset;cursor:pointer;font:inherit;font-size:11.5px;color:var(--dim);text-decoration:underline;padding:6px 4px';
    const row = el('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px';
    if (want.kind === 'nudge') {
      card.setAttribute('role', 'status');
      card.append(el('strong', null, 'Record this meeting?'), el('p', null, want.text));
      row.append(
        btn('Not now', pillBtn, () => {
          nudgeCtl.dismiss(want.key);
          cardNudge = null;
          send({ type: 'nudge-dismiss', key: want.key });
          render();
        }),
        btn("Don't remind me", link, () => {
          nudgeCtl.dismiss(want.key);
          cardNudge = null;
          send({ type: 'set-nudge', on: false });
          render();
        })
      );
    } else {
      card.setAttribute('role', 'alert');
      card.append(el('strong', null, 'Recording notice not posted'), el('p', null, want.text));
      row.append(
        btn('OK', pillBtn, () => {
          noticeAlert = null;
          render();
        })
      );
    }
    card.append(row);
  }

  function render() {
    if (!host) return;
    const rec = S.rec;
    const mine = rec.recording && !rec.stopping && rec.tabId === myTab;
    const pillOn = mine && S.showPill && hiddenFor !== rec.startedAt;
    renderCard();
    // The reminder is its own setting: its card shows even when the pill is switched off.
    host.style.display = pillOn || cardOn ? '' : 'none';
    pill.classList.toggle('hidden', !pillOn);
    if (!pillOn) {
      panel.classList.add('hidden');
      return;
    }

    timeEl.textContent = fmt((Date.now() - rec.startedAt) / 1000);
    const lv = S.levels;
    const fresh = lv && Date.now() - lv.at < 4000;
    const peak = fresh ? Math.max(lv.tab || 0, lv.mic || 0) : 0;
    eq.classList.toggle('live', peak >= 0.012);
    const isPaused = !!rec.paused;
    eq.classList.toggle('hidden', !fresh || isPaused);
    silentMsg.textContent = isPaused ? 'Paused' : 'No audio is arriving';
    silentMsg.classList.toggle('hidden', !!fresh && !isPaused);
    pill.classList.toggle('silent', !fresh);
    const alert = rec.alert;
    warnChip.classList.toggle('show', !!alert);
    warnChip.textContent = alert?.kind === 'key' ? 'API key' : 'Limit';

    const wanted = rec.micWanted ?? rec.micOn;
    const paused = wanted && !rec.micOn;
    const live = wanted && !paused; // the mic is in the recording right now (not switched off, and not muted in the call)
    micBtn.className = 'mic ' + (!rec.mic ? 'off' : paused ? 'muted' : wanted ? 'on' : 'off');
    micBtn.innerHTML = (live ? MIC_ON : MIC_OFF) + (!rec.mic ? 'No mic' : live ? 'Mic on' : 'Mic off');
    micBtn.disabled = !rec.mic;
    const micTitle = !rec.mic
      ? 'Microphone not available to Debrief'
      : paused
        ? 'Your mic follows your mute button in the call: it is off while you are muted and comes back when you unmute. Click to ignore it for the whole meeting.'
        : wanted
          ? 'Your mic is in the transcript. Click to ignore it.'
          : 'Your mic is ignored. Click to include it.';
    micBtn.title = micTitle;
    micBtn.setAttribute('aria-label', 'Microphone: ' + micBtn.textContent.trim() + '. ' + (rec.mic ? 'Click to change' : 'Not available'));

    toggle.setAttribute('aria-expanded', String(expanded));
    pill.classList.toggle('open', expanded);
    toggle.setAttribute('aria-label', `Debrief recording, ${timeEl.textContent}. ${expanded ? 'Hide' : 'Show'} details`);
    // Announce only changes of state, never the ticking timer.
    const say = alert ? alert.title : isPaused ? 'Recording is paused' : !fresh ? 'No audio is arriving' : 'Debrief is recording';
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
    // (the level meters are not part of it: they change every second while someone speaks, and are updated in place)
    const sig = JSON.stringify([S.counts, alert?.at, !!fresh, !!rec.mic, !!wanted, !!paused, isPaused]);
    if (sig === panelSig) {
      const ms = panel.querySelectorAll('.meter');
      if (ms[0]) paintMeter(ms[0], fresh ? lv.tab : null);
      if (ms[1] && rec.mic && wanted && !paused) paintMeter(ms[1], fresh ? lv.mic : null);
      return;
    }
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
        ? 'Only the call is being recorded. Your mic comes back when you unmute.'
        : wanted
          ? 'Your voice is going into the transcript.'
          : 'Your mic is not recorded. The call still is.';
    panel.append(el('p', 'line', line));
    panel.append(el('p', 'line', `${S.counts.segs} transcript piece${S.counts.segs === 1 ? '' : 's'} · ${S.counts.errs} error${S.counts.errs === 1 ? '' : 's'}`));
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
    const pauseBtn = el('button', 'stop');
    pauseBtn.type = 'button';
    pauseBtn.dataset.k = 'pause';
    pauseBtn.style.cssText = 'margin-bottom:8px;background:transparent;color:inherit;border:1px solid currentColor';
    pauseBtn.textContent = isPaused ? 'Resume recording' : 'Pause recording';
    pauseBtn.onclick = async () => {
      await send({ type: 'pause' });
      await load();
      render();
    };
    panel.append(pauseBtn);
    const stop = el('button', 'stop');
    stop.type = 'button';
    stop.dataset.k = 'stop';
    stop.innerHTML = STOP_ICON + 'Stop and write minutes';
    stop.onclick = () => send({ type: 'stop' });
    panel.append(stop);
    const discard = el('button', 'stop');
    discard.type = 'button';
    discard.dataset.k = 'discard';
    discard.textContent = discardArmed ? 'Tap again to delete it' : 'Started by mistake? Discard';
    discard.style.cssText = 'background:none;box-shadow:none;color:var(--dim);font-size:12px;text-decoration:underline;min-height:28px;opacity:.85';
    discard.onclick = () => {
      if (!discardArmed) {
        // the armed state lives here, not on the button: the panel is rebuilt whenever something visible changes
        discardArmed = true;
        discard.textContent = 'Tap again to delete it';
        clearTimeout(discardTimer);
        discardTimer = setTimeout(() => {
          discardArmed = false;
          const b = panel.querySelector('[data-k="discard"]');
          if (b) b.textContent = 'Started by mistake? Discard';
        }, 5000);
        return;
      }
      discardArmed = false;
      clearTimeout(discardTimer);
      send({ type: 'discard' });
    };
    panel.append(discard);
    if (keep) panel.querySelector(`[data-k="${keep}"]`)?.focus();
  }

  function reportMute(call) {
    if (!S.rec.recording || S.rec.tabId !== myTab) {
      lastSentMute = undefined;
      return;
    }
    const m = meetMuted(call);
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

  // The recording notice in the meeting chat (Google Meet only, if switched on). The rules are in adapters/pillrules.js.
  async function maybeNotice(call) {
    const rec = S.rec;
    const mine = rec.recording && !rec.stopping && rec.tabId === myTab;
    const go = noticeCtl.begin({ now: Date.now(), recKey: mine ? rec.meetingId : null, adapterId: app.id, room: !!rec.room, paused: !!rec.paused, inCall: call, notice: S.notice });
    if (!go) return;
    let r;
    try {
      r = await app.postNotice(document, S.notice.text);
    } catch (e) {
      r = { ok: false, why: `chat error: ${e?.message || e}` };
    }
    const out = noticeCtl.finish(r, Date.now());
    if (out.report) await send({ type: 'notice-result', ...out.report });
    if (out.alert) {
      noticeAlert = { text: out.alert, until: Date.now() + 30000 };
      render();
    }
  }

  // Tells the recorder when someone starts or stops presenting (so it can describe the shared screen). Reading the page for it is
  // the costliest check the pill makes, so it is done every 5 s, and only while this tab is recording with screen notes on
  // (S.screenNotes; a reply without that field is read as "on" while recording).
  const PRESENT_EVERY_MS = 5000;
  let lastPresAt = 0;
  let lastPres = null;
  let lastPresKey = null;
  function reportPresenting(call) {
    const mine = S.rec.recording && !S.rec.stopping && S.rec.tabId === myTab;
    const key = mine ? S.rec.meetingId : null;
    const wanted = mine && !!app.presenting && S.screenNotes !== false;
    const now = Date.now();
    if (key !== lastPresKey) {
      lastPresKey = key;
      lastPresAt = 0; // a new recording is looked at straight away
      lastPres = null;
    }
    if (wanted && now - lastPresAt >= PRESENT_EVERY_MS) {
      lastPresAt = now;
      lastPres = app.presenting(document, call);
    }
    const out = presentingRep.step(key, wanted ? lastPres : null);
    if (out) send({ type: 'presenting', ...out });
  }

  // "Record this meeting?": asked when a call matches one of the user's meeting types. It only asks: Chrome allows a tab
  // recording to start only from the extension button or its shortcut.
  let cardNudge = null;
  let nudgeShownThisCall = false;
  let nudgePeople = []; // the last reading: kept while the card is up, the card does not need a fresh one
  function maybeNudge(call) {
    if (!call) {
      nudgeShownThisCall = false;
      nudgePeople = [];
    }
    // who is in the call matters only for deciding whether to ask: not while recording, with reminders off, or once it was asked
    if (call && S.nudge?.on && !S.rec.recording && !nudgeShownThisCall && app.hasPeople) nudgePeople = app.readParticipants(document);
    const n = nudgeCtl.step({
      now: Date.now(),
      recording: !!S.rec.recording,
      inCall: call,
      cfg: S.nudge,
      title: document.title,
      url: location.href,
      participants: nudgePeople,
      shortcut: S.shortcut,
    });
    if (n) nudgeShownThisCall = true;
    cardNudge = n;
    // a tab nobody is looking at also gets one system notification per call (the background keeps count)
    if (n && document.hidden && !notified.has(n.key)) {
      notified.add(n.key);
      send({ type: 'nudge-dismiss', key: n.key, notified: true });
    }
    render();
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
  function reportCall(on) {
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
    const call = !!app.inCall(document); // asked once per tick and handed down: it reads a lot of the page
    reportMute(call);
    checkEnded();
    sampleMeeting();
    reportCall(call);
    maybeNotice(call);
    reportPresenting(call);
    maybeNudge(call);
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
