(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/adapters/meet.js
  var meet_exports = {};
  __export(meet_exports, {
    captionsButton: () => captionsButton,
    captionsRegion: () => captionsRegion,
    diagnose: () => diagnose,
    endScreen: () => endScreen,
    inCall: () => inCall,
    micButton: () => micButton,
    readCaptions: () => readCaptions,
    readParticipants: () => readParticipants,
    snapshot: () => snapshot
  });

  // src/meetend.js
  var BUTTON_ONLY = /^(rejoin|return to (the )?home screen)$/i;
  var HEADLINE = /(you(?:'|’)?ve|you have) left the meeting|you left the meeting|the meeting has ended|this call has ended|call ended|you(?:'|’)?ve been removed from the meeting|you were removed from the meeting|meeting ended/i;
  function meetingEnded(texts) {
    return (texts || []).some((raw) => {
      const t = String(raw || "").replace(/\s+/g, " ").trim();
      return t.length > 0 && t.length < 120 && (BUTTON_ONLY.test(t) || HEADLINE.test(t));
    });
  }

  // src/iconText.js
  var isIconText = (s) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(s || "").trim());
  var MENU = /^(?:(?:un)?pin|spotlight|remove|mute|unmute|reframe|zoom (?:in|out)|minimi[sz]e|maximi[sz]e|full screen|more actions|add (?:a )?(?:person|people)|keep|send a message)\b.*$/i;
  var UI_PHRASE = /(?:\bcan['\u2019]?t\b|\bcannot\b|\bremotely\b|\bsomeone else\b|\bthis participant\b|^you (?:are|have|will|can)\b|^turn (?:on|off)\b|^(?:backgrounds?|effects?|captions?|activities|host controls|meeting details|participants|people|in the call|contributors|visual effects|apply visual effects|more options|raise hand|lower hand|present now|share screen|leave call|end call|chat|reactions?)(?:\s+(?:and|&)\s+\w+)?$)/i;
  var isMenuText = (s) => {
    const t = String(s || "").trim();
    if (UI_PHRASE.test(t) || t.split(/\s+/).length > 6) return true;
    return /\b(?:to|from) your main screen\b/i.test(t) || /^(?:reframe|zoom in|zoom out|keep|pin|unpin)$/i.test(t) || /^(?:un)?pin\s/i.test(t) || MENU.test(t) && /\b(?:screen|presentation|participant|tile|view)\b/i.test(t);
  };
  var personOfTile = (s) => String(s || "").replace(/[’']s presentation\s*$/i, "").replace(/^more options for\s+/i, "").trim();

  // src/adapters/meet.js
  var text = (el) => (el?.innerText ?? el?.textContent ?? "").replace(/ /g, " ").trim();
  var lines = (el) => text(el).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  var NOT_A_NAME = /^(you|your|presenting|pinned|unpin|pin|mute|unmute|muted|more options|more|host|co-host|\d+|\d+ more|\+\d+|raised hand|lower hand|audio|video|camera|microphone|remove|admit|deny|in the meeting|contributors|people|participants|visible|backgrounds?)$/i;
  function cleanName(raw) {
    if (isMenuText(raw)) return "";
    const n = personOfTile(String(raw || "").replace(/\s*\((you|host|presenting|co-host)\)\s*$/i, "").replace(/\s+/g, " ")).trim();
    if (!n || n.length > 60 || isIconText(n) || isMenuText(n) || NOT_A_NAME.test(n) || /^[\d\s:.-]+$/.test(n)) return "";
    return n;
  }
  function micButton(doc) {
    const withAttr = [...doc.querySelectorAll('button[data-is-muted], [role="button"][data-is-muted]')];
    const labelled = withAttr.find((b) => /microphone|mic\b/i.test(b.getAttribute("aria-label") || ""));
    if (labelled) return { el: labelled, muted: labelled.getAttribute("data-is-muted") === "true" };
    const toggles = withAttr.filter((b) => !/camera|video|cam\b/i.test(b.getAttribute("aria-label") || ""));
    if (!labelled && withAttr.length === 2 && toggles.length >= 1) return { el: toggles[0], muted: toggles[0].getAttribute("data-is-muted") === "true" };
    const byLabel = [...doc.querySelectorAll("button[aria-label]")].find((b) => /turn (on|off) microphone/i.test(b.getAttribute("aria-label")));
    if (byLabel) return { el: byLabel, muted: /turn on/i.test(byLabel.getAttribute("aria-label")) };
    return null;
  }
  function readParticipants(doc) {
    const names = /* @__PURE__ */ new Set();
    const panel = [...doc.querySelectorAll('[role="list"]')].find((l) => /participants|people|in the meeting|contributors/i.test(l.getAttribute("aria-label") || ""));
    if (panel) {
      for (const item of panel.querySelectorAll('[role="listitem"]')) {
        const n = cleanName(item.getAttribute("aria-label")) || cleanName(lines(item)[0]);
        if (n) names.add(n);
      }
    }
    if (!names.size) {
      for (const tile of doc.querySelectorAll("[data-participant-id]")) {
        const self = tile.querySelector("[data-self-name]")?.getAttribute("data-self-name");
        const n = cleanName(self) || cleanName(lines(tile).find((l) => cleanName(l)));
        if (n) names.add(n);
      }
    }
    return [...names];
  }
  function captionsRegion(doc) {
    return [...doc.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]')].find((r) => /caption/i.test(r.getAttribute("aria-label") || "")) || null;
  }
  function readCaptions(doc) {
    const region = captionsRegion(doc);
    if (!region) return [];
    const blocks = [...region.querySelectorAll(":scope > div, :scope > div > div")].filter((b) => lines(b).length >= 2 && !b.querySelector(":scope > div > div > div > div > div"));
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const b of blocks) {
      const l = lines(b);
      const name = cleanName(l[0]);
      const said = l.slice(1).join(" ").trim();
      const key = `${name}|${said}`;
      if (name && said && !seen.has(key)) {
        seen.add(key);
        out.push({ name, text: said });
      }
    }
    return out;
  }
  function captionsButton(doc) {
    return [...doc.querySelectorAll("button[aria-label]")].find((b) => /turn on captions|captions \(c\)|show captions/i.test(b.getAttribute("aria-label") || "")) || null;
  }
  function endScreen(doc) {
    if (micButton(doc) && [...doc.querySelectorAll("button[aria-label]")].some((b) => /leave call/i.test(b.getAttribute("aria-label")))) return false;
    const texts = [...doc.querySelectorAll('button, [role="button"], h1, h2, [role="heading"]')].slice(0, 300).map(text);
    return meetingEnded(texts);
  }
  function inCall(doc) {
    const leave = [...doc.querySelectorAll("button[aria-label]")].some((b) => /leave call/i.test(b.getAttribute("aria-label")));
    return !!(micButton(doc) && leave && !endScreen(doc));
  }
  function snapshot(doc) {
    return { mic: micButton(doc), participants: readParticipants(doc), captions: readCaptions(doc), ended: endScreen(doc) };
  }
  function diagnose(doc) {
    const s = snapshot(doc);
    return {
      app: "Google Meet",
      micButton: s.mic ? `found, ${s.mic.muted ? "muted" : "unmuted"}` : "NOT found",
      participants: s.participants.length ? `${s.participants.length} found: ${s.participants.slice(0, 6).join(", ")}` : "none found (open the People panel, or join the call first)",
      captions: captionsRegion(doc) ? `region found, ${s.captions.length} caption block(s) now${s.captions[0] ? `, e.g. "${s.captions[0].name}"` : ""}` : "captions are not showing (turn them on with the CC button)",
      captionsButton: captionsButton(doc) ? "found" : "not found (captions may already be on)",
      inCall: inCall(doc) ? "yes, a call is on" : "no call detected (lobby or not joined yet)",
      endScreen: s.ended ? "the end-of-meeting screen is showing" : "no (normal while in a call)"
    };
  }

  // src/adapters/generic.js
  var generic_exports = {};
  __export(generic_exports, {
    diagnose: () => diagnose2,
    endScreen: () => endScreen2,
    inCall: () => inCall2,
    leaveButton: () => leaveButton,
    micButton: () => micButton2,
    snapshot: () => snapshot2
  });
  var text2 = (el) => (el?.innerText ?? el?.textContent ?? "").replace(/ /g, " ").trim();
  var MUTE_LABEL = /^(un-?mute|mute)( my| the)?( (microphone|mic|audio))?( \(.*\))?$/i;
  var OUTSIDE = '[role="list"], [role="listitem"], [role="dialog"], [role="menu"], video, [class*="player" i]';
  function micButton2(doc) {
    const buttons = [...doc.querySelectorAll('button, [role="button"], [role="switch"]')].filter((b) => !b.closest(OUTSIDE));
    const names = (b) => [b.getAttribute("aria-label"), b.getAttribute("title"), text2(b)].map((x) => (x || "").trim()).filter(Boolean);
    for (const b of buttons) {
      for (const n of names(b)) {
        if (/^turn on (my |your )?(microphone|mic)\b/i.test(n)) return { el: b, muted: true };
        if (/^turn off (my |your )?(microphone|mic)\b/i.test(n)) return { el: b, muted: false };
        const m = n.match(MUTE_LABEL);
        if (m) return { el: b, muted: /^un/i.test(m[1]) };
      }
      const l = (b.getAttribute("aria-label") || "").trim();
      if (/^microphone$/i.test(l) && b.getAttribute("aria-pressed") != null) return { el: b, muted: b.getAttribute("aria-pressed") === "false" };
    }
    return null;
  }
  var LEAVE_LABEL = /^(leave|end|leave (call|meeting|session)|hang up|end (call|meeting|session)|end for (me|everyone|all)|end meeting for all)( \(.*\))?$/i;
  function leaveButton(doc) {
    return [...doc.querySelectorAll('button, [role="button"]')].find((b) => !b.closest('[role="list"], [role="listitem"], [role="dialog"], [role="menu"]') && [b.getAttribute("aria-label"), b.getAttribute("title"), text2(b)].some((n) => LEAVE_LABEL.test((n || "").trim()))) || null;
  }
  function inCall2(doc) {
    return !!(micButton2(doc) && leaveButton(doc) && !endScreen2(doc));
  }
  function endScreen2(doc) {
    if (micButton2(doc) && leaveButton(doc)) return false;
    const texts = [...doc.querySelectorAll('button, [role="button"], h1, h2, h3, [role="heading"]')].slice(0, 300).map(text2);
    return meetingEnded(texts) || texts.some((t) => /^(this )?(meeting|call) (has )?(been )?ended( by (the )?host)?\.?$/i.test(t.trim()));
  }
  function snapshot2(doc) {
    return { mic: micButton2(doc), participants: [], captions: [], ended: endScreen2(doc), inCall: inCall2(doc) };
  }
  function diagnose2(doc, name = "This meeting app") {
    const s = snapshot2(doc);
    return {
      app: `${name} (experimental, generic detection)`,
      micButton: s.mic ? `found, ${s.mic.muted ? "muted" : "unmuted"}` : "NOT found: use the manual mic switch",
      participants: "not read for this app",
      captions: "not read for this app",
      inCall: s.inCall ? "yes, a call is on" : "no call detected",
      endScreen: s.ended ? "the end-of-meeting screen is showing" : "no (normal while in a call)"
    };
  }

  // src/adapters/index.js
  var OTHER_SITES = [
    { name: "Zoom (web client)", matches: ["https://app.zoom.us/*", "https://*.zoom.us/wc/*", "https://zoom.us/wc/*"] },
    { name: "Microsoft Teams", matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*", "https://teams.cloud.microsoft/*"] },
    { name: "Webex", matches: ["https://*.webex.com/*"] },
    { name: "Whereby", matches: ["https://whereby.com/*"] },
    { name: "Jitsi Meet", matches: ["https://meet.jit.si/*", "https://8x8.vc/*"] },
    { name: "GoTo Meeting", matches: ["https://app.goto.com/*", "https://app.gotomeeting.com/*"] },
    { name: "BlueJeans", matches: ["https://app.bluejeans.com/*"] },
    { name: "Amazon Chime", matches: ["https://app.chime.aws/*"] },
    { name: "Zoho Meeting", matches: ["https://meeting.zoho.com/*", "https://meeting.zoho.in/*", "https://meeting.zoho.eu/*"] },
    { name: "Skype for Web", matches: ["https://web.skype.com/*"] }
  ];
  var hostOf = (pattern) => pattern.replace(/^https:\/\//, "").split("/")[0];
  var hostMatches = (pattern, hostname) => {
    const h = hostOf(pattern);
    return h.startsWith("*.") ? hostname === h.slice(2) || hostname.endsWith(h.slice(1)) : hostname === h;
  };
  function siteFor(hostname) {
    return OTHER_SITES.find((s) => s.matches.some((m) => hostMatches(m, hostname))) || null;
  }
  function adapterFor(hostname) {
    if (hostname === "meet.google.com") return { id: "meet", name: "Google Meet", ...meet_exports, hasPeople: true };
    const site = siteFor(hostname);
    return { id: "generic", name: site?.name || hostname, ...generic_exports, diagnose: (doc) => diagnose2(doc, site?.name || hostname), hasPeople: false };
  }

  // src/pill.js
  (() => {
    if (window.__debriefPill) return;
    const app = adapterFor(location.hostname);
    window.__debriefPill = true;
    const POS_KEY = "debrief.pill.pos";
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
        return await chrome.runtime.sendMessage({ target: "bg", ...msg });
      } catch {
        if (!alive()) shutdown();
        return null;
      }
    };
    const el = (tag, cls, text3) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text3 != null) e.textContent = text3;
      return e;
    };
    const fmt = (sec) => {
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600);
      const m = String(Math.floor(sec % 3600 / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      return h ? `${h}:${m}:${s}` : `${m}:${s}`;
    };
    const meetMuted = () => app.id === "generic" && !app.inCall(document) ? null : app.micButton(document)?.muted ?? null;
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
    let panelSig = "";
    let lastStatus = "";
    async function load() {
      const r = await send({ type: "pill-state" });
      if (r?.ok) S = r;
    }
    function flip() {
      if (!host || !wrap) return;
      const r = host.getBoundingClientRect();
      wrap.classList.toggle("up", r.top + r.height / 2 > innerHeight / 2);
    }
    function clampIn() {
      if (!host || host.style.display === "none") return;
      const r = host.getBoundingClientRect();
      if (!r.width) return;
      if (r.right > innerWidth || r.left < 0) host.style.right = Math.max(0, Math.min(innerWidth - r.width, innerWidth - r.right)) + "px";
      if (r.bottom > innerHeight || r.top < 0) host.style.bottom = Math.max(0, Math.min(innerHeight - r.height, innerHeight - r.bottom)) + "px";
      flip();
    }
    function setExpanded(v) {
      if (expanded === v) return;
      expanded = v;
      panelSig = "";
      render();
    }
    function mount() {
      host = document.createElement("div");
      host.setAttribute("data-debrief", "");
      let pos = { right: 18, bottom: Math.max(92, innerHeight - 18 - 36) };
      try {
        const p = JSON.parse(localStorage.getItem(POS_KEY));
        if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) pos = p;
      } catch {
      }
      host.style.cssText = `position:fixed;right:${pos.right}px;bottom:${pos.bottom}px;z-index:2147483646;display:none;pointer-events:none;`;
      const root = host.attachShadow({ mode: "closed" });
      host.__debriefRoot = root;
      const style = el("style");
      style.textContent = CSS;
      wrap = el("div", "wrap");
      panel = el("div", "panel hidden");
      panel.id = "dbPanel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Recording details");
      panel.tabIndex = -1;
      pill = el("div", "pill");
      pill.setAttribute("role", "button");
      pill.tabIndex = 0;
      pill.setAttribute("aria-expanded", "false");
      pill.setAttribute("aria-controls", "dbPanel");
      status = el("span", "sr");
      status.setAttribute("role", "status");
      const dot = el("span", "rd");
      dot.setAttribute("aria-hidden", "true");
      eq = el("span", "eq");
      eq.setAttribute("aria-hidden", "true");
      eq.append(el("i"), el("i"), el("i"), el("i"));
      silentMsg = el("span", "silentmsg hidden", "No audio is arriving");
      timeEl = el("span", "time", "00:00");
      warnChip = el("span", "warn-chip");
      micBtn = el("button", "mic");
      micBtn.type = "button";
      pill.append(dot, eq, silentMsg, timeEl, warnChip, micBtn);
      wrap.append(status, panel, pill);
      root.append(style, wrap);
      document.documentElement.appendChild(host);
      micBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      micBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await send({ type: "mic", on: !(S.rec.micWanted ?? S.rec.micOn) });
        await load();
        render();
      });
      pill.addEventListener("keydown", (e) => {
        if (e.target !== pill) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded(!expanded);
        }
      });
      drag(pill);
      document.addEventListener("pointerdown", (e) => {
        if (expanded && !e.composedPath().includes(host)) setExpanded(false);
      }, true);
      document.addEventListener("keydown", (e) => {
        if (expanded && e.key === "Escape") {
          setExpanded(false);
          pill.focus();
        }
      }, true);
      document.addEventListener("fullscreenchange", () => {
        const fs = document.fullscreenElement;
        const home = fs && fs.tagName !== "VIDEO" && fs.tagName !== "IFRAME" ? fs : document.documentElement;
        if (host.parentNode !== home) home.appendChild(host);
        clampIn();
        if (S.rec?.recording && S.rec.tabId === myTab) send({ type: "window-fullscreen", on: !!fs, auto: true });
      });
      addEventListener("resize", clampIn);
      flip();
    }
    function drag(target) {
      let st = null;
      target.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const r = host.getBoundingClientRect();
        st = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
        }
      });
      target.addEventListener("pointermove", (e) => {
        if (!st) return;
        const dx = e.clientX - st.x;
        const dy = e.clientY - st.y;
        if (!st.moved && Math.hypot(dx, dy) < 4) return;
        if (!st.moved) pill.classList.add("dragging");
        st.moved = true;
        host.style.right = Math.max(0, Math.min(innerWidth - 60, st.right - dx)) + "px";
        host.style.bottom = Math.max(0, Math.min(innerHeight - 36, st.bottom - dy)) + "px";
        flip();
      });
      target.addEventListener("pointerup", () => {
        if (!st) return;
        pill.classList.remove("dragging");
        if (st.moved) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({ right: parseInt(host.style.right, 10), bottom: parseInt(host.style.bottom, 10) }));
          } catch {
          }
        } else {
          setExpanded(!expanded);
        }
        st = null;
      });
      target.addEventListener("pointercancel", () => {
        pill.classList.remove("dragging");
        st = null;
      });
    }
    const label = (v) => v == null ? "Off" : v < 3e-3 ? "Silent" : v < 0.012 ? "Very quiet" : "Good";
    function meter(name, v, text3) {
      const box = el("div", "meter");
      const top = el("div", "top");
      const word = text3 || label(v);
      top.append(el("span", null, name), el("span", "w", word));
      const b = el("div", "m");
      const pct = v == null ? 0 : Math.min(100, Math.round(Math.sqrt(v) * 160));
      b.setAttribute("role", "meter");
      b.setAttribute("aria-label", name);
      b.setAttribute("aria-valuemin", "0");
      b.setAttribute("aria-valuemax", "100");
      b.setAttribute("aria-valuenow", String(pct));
      b.setAttribute("aria-valuetext", word);
      const f = el("i", v != null && v < 0.012 ? "q" : "");
      f.style.width = pct + "%";
      b.append(f);
      box.append(top, b);
      return box;
    }
    const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2.5" fill="currentColor"></rect></svg>';
    function render() {
      if (!host) return;
      const rec = S.rec;
      const mine = rec.recording && !rec.stopping && rec.tabId === myTab;
      host.style.display = mine && S.showPill ? "" : "none";
      if (!mine || !S.showPill) return;
      timeEl.textContent = fmt((Date.now() - rec.startedAt) / 1e3);
      const lv = S.levels;
      const fresh = lv && Date.now() - lv.at < 4e3;
      const peak = fresh ? Math.max(lv.tab || 0, lv.mic || 0) : 0;
      eq.classList.toggle("live", peak >= 0.012);
      const isPaused = !!rec.paused;
      eq.classList.toggle("hidden", !fresh || isPaused);
      silentMsg.textContent = isPaused ? "Paused" : "No audio is arriving";
      silentMsg.classList.toggle("hidden", !!fresh && !isPaused);
      pill.classList.toggle("silent", !fresh);
      const alert = rec.alert;
      warnChip.classList.toggle("show", !!alert);
      warnChip.textContent = alert?.kind === "key" ? "API key" : "Limit";
      const wanted = rec.micWanted ?? rec.micOn;
      const paused = wanted && !rec.micOn;
      micBtn.className = "mic " + (!rec.mic ? "off" : paused ? "muted" : wanted ? "on" : "off");
      micBtn.innerHTML = (wanted && !paused ? MIC_ON : MIC_OFF) + (!rec.mic ? "No mic" : paused ? "Muted in call" : wanted ? "Mic on" : "Mic off");
      micBtn.disabled = !rec.mic;
      const micTitle = !rec.mic ? "Microphone not available to Debrief" : paused ? "You are muted in the call, so Debrief is ignoring your mic. Click to stop including it." : wanted ? "Your mic is in the transcript. Click to ignore it." : "Your mic is ignored. Click to include it.";
      micBtn.title = micTitle;
      micBtn.setAttribute("aria-label", "Microphone: " + micBtn.textContent.trim() + ". " + (rec.mic ? "Click to change" : "Not available"));
      pill.setAttribute("aria-expanded", String(expanded));
      pill.classList.toggle("open", expanded);
      pill.setAttribute("aria-label", `Debrief recording, ${timeEl.textContent}. ${expanded ? "Hide" : "Show"} details`);
      const say = alert ? alert.title : isPaused ? "Recording is paused" : !fresh ? "No audio is arriving" : paused ? "You are muted in the call" : "Debrief is recording";
      if (say !== lastStatus) {
        lastStatus = say;
        status.textContent = say;
      }
      pill.classList.toggle("alert", !fresh);
      panel.classList.toggle("hidden", !expanded);
      if (!expanded) {
        panelSig = "";
        return;
      }
      const sig = JSON.stringify([peak > 0 ? Math.round(lv.tab * 1e3) : 0, fresh && rec.micOn ? Math.round((lv.mic || 0) * 1e3) : -1, S.counts, alert?.at, !!fresh, !!rec.mic, !!wanted, !!paused, isPaused]);
      if (sig === panelSig) return;
      panelSig = sig;
      const active = panel.getRootNode().activeElement;
      const keep = active && panel.contains(active) ? active.dataset.k : null;
      panel.replaceChildren();
      panel.append(meter("Meeting audio", fresh ? lv.tab : null));
      if (!rec.mic) panel.append(meter("Your mic", null, "Unavailable"));
      else if (paused) panel.append(meter("Your mic", 1e-3, "Paused"));
      else if (!wanted) panel.append(meter("Your mic", null, "Ignored"));
      else panel.append(meter("Your mic", fresh ? lv.mic : null));
      const line = !rec.mic ? "Debrief can't reach your microphone. The call is still recorded." : paused ? "You are muted in the call, so Debrief pauses your mic." : wanted ? "Your voice is going into the transcript." : "Your mic is not recorded. The call still is.";
      panel.append(el("p", "line", line));
      panel.append(el("p", "line", `${S.counts.segs} pieces transcribed \xB7 ${S.counts.errs} ${S.counts.errs === 1 ? "error" : "errors"}`));
      if (!fresh) {
        const box = el("div", "note");
        box.setAttribute("role", "alert");
        box.append(el("strong", null, "No audio is arriving"), "If this stays, stop and start the recording again.");
        panel.append(box);
      }
      if (alert) {
        const box = el("div", "note");
        box.setAttribute("role", "alert");
        const x = el("button", "x", "\xD7");
        x.type = "button";
        x.dataset.k = "dismiss";
        x.title = "Dismiss";
        x.setAttribute("aria-label", "Dismiss alert");
        x.onclick = async () => {
          await send({ type: "dismiss-alert" });
          await load();
          render();
        };
        box.append(x, el("strong", null, alert.title), alert.detail || "");
        panel.append(box);
      }
      const row = el("div", "row");
      const sw = el("button", "psw");
      sw.type = "button";
      sw.dataset.k = "mic";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(!!wanted));
      sw.setAttribute("aria-label", "Include my microphone");
      sw.disabled = !rec.mic;
      sw.onclick = async () => {
        await send({ type: "mic", on: !(S.rec.micWanted ?? S.rec.micOn) });
        await load();
        render();
      };
      row.append(el("span", "grow", "Include my microphone"), sw);
      panel.append(row);
      const pauseBtn = el("button", "stop");
      pauseBtn.type = "button";
      pauseBtn.dataset.k = "pause";
      pauseBtn.style.cssText = "margin-bottom:8px;background:transparent;color:inherit;border:1px solid currentColor";
      pauseBtn.textContent = isPaused ? "Resume recording" : "Pause recording";
      pauseBtn.onclick = async () => {
        await send({ type: "pause" });
        await load();
        render();
      };
      panel.append(pauseBtn);
      const stop = el("button", "stop");
      stop.type = "button";
      stop.dataset.k = "stop";
      stop.innerHTML = STOP_ICON + "Stop and write minutes";
      stop.onclick = () => send({ type: "stop" });
      panel.append(stop);
      if (keep) panel.querySelector(`[data-k="${keep}"]`)?.focus();
    }
    function reportMute() {
      if (!S.rec.recording || S.rec.tabId !== myTab) {
        lastSentMute = void 0;
        return;
      }
      const m = meetMuted();
      if (m !== lastSentMute) {
        lastSentMute = m;
        send({ type: "meet-mute", muted: m });
      }
    }
    let endedHits = 0;
    function checkEnded() {
      if (!S.rec.recording || S.rec.stopping || S.rec.tabId !== myTab) {
        endedHits = 0;
        return;
      }
      endedHits = app.endScreen(document) ? endedHits + 1 : 0;
      if (endedHits === 2 || endedHits > 2 && endedHits % 30 === 0) send({ type: "meet-ended" });
    }
    let lastPeople = "";
    let lastCaps = /* @__PURE__ */ new Map();
    let captionTries = 0;
    function sampleMeeting() {
      if (!S.rec.recording || S.rec.stopping || S.rec.tabId !== myTab || !app.hasPeople) return;
      const mode = S.captionMode || "read";
      const t = Math.max(0, (Date.now() - S.rec.startedAt) / 1e3);
      const people = app.readParticipants(document);
      const key = people.join("|");
      const payload = {};
      if (key !== lastPeople) {
        lastPeople = key;
        payload.names = people;
      }
      if (mode !== "off") {
        if (mode === "auto" && captionTries < 3 && !app.captionsRegion(document)) {
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
      if (payload.names || payload.captions) send({ type: "meet-snap", t, ...payload });
    }
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg?.target === "page" && msg.type === "diagnose") {
        try {
          reply({ ok: true, diag: app.diagnose(document), site: app.name });
        } catch (e) {
          reply({ ok: false, error: e.message });
        }
      }
    });
    let lastInCall;
    function reportCall() {
      const on = !!app.inCall(document);
      if (on !== lastInCall) {
        lastInCall = on;
        send({ type: "in-call", on, site: app.name });
      }
    }
    async function tick() {
      if (!alive()) return shutdown();
      await load();
      render();
      if (app.id === "generic" && S.otherSites === false) return;
      reportMute();
      checkEnded();
      sampleMeeting();
      reportCall();
    }
    async function init() {
      document.querySelectorAll("[data-debrief]").forEach((n) => n.remove());
      const r = await send({ type: "whoami" });
      myTab = r?.tabId ?? null;
      mount();
      await tick();
      timer = setInterval(tick, 1e3);
    }
    init();
  })();
})();
