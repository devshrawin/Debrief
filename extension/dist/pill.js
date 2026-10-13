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

  // src/adapters/meet.js
  var text = (el) => (el?.innerText ?? el?.textContent ?? "").replace(/ /g, " ").trim();
  var lines = (el) => text(el).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  var NOT_A_NAME = /^(you|your|presenting|pinned|unpin|pin|mute|unmute|muted|more options|more|host|co-host|\d+|\d+ more|\+\d+|raised hand|lower hand|audio|video|camera|microphone|remove|admit|deny|in the meeting|contributors|people|participants|visible|backgrounds?)$/i;
  function cleanName(raw) {
    const n = String(raw || "").replace(/\s*\((you|host|presenting|co-host)\)\s*$/i, "").replace(/\s+/g, " ").trim();
    if (!n || n.length > 60 || NOT_A_NAME.test(n) || /^[\d\s:.-]+$/.test(n)) return "";
    return n;
  }
  function micButton(doc) {
    const withAttr = [...doc.querySelectorAll('button[data-is-muted], [role="button"][data-is-muted]')];
    const labelled = withAttr.find((b) => /microphone|mic\b/i.test(b.getAttribute("aria-label") || ""));
    if (labelled) return { el: labelled, muted: labelled.getAttribute("data-is-muted") === "true" };
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
  var label = (el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("data-tid") || ""}`.trim();
  function micButton2(doc) {
    const candidates = [...doc.querySelectorAll('button, [role="button"], [role="switch"]')];
    for (const b of candidates) {
      const l = label(b);
      if (/(^|\b)(un-?mute)\b.{0,20}(mic|audio)?/i.test(l) && !/camera|video/i.test(l)) return { el: b, muted: true };
      if (/turn on (your )?(microphone|mic)/i.test(l)) return { el: b, muted: true };
    }
    for (const b of candidates) {
      const l = label(b);
      if (/(^|\b)mute\b.{0,20}(mic|audio)?/i.test(l) && !/camera|video|un-?mute/i.test(l)) return { el: b, muted: false };
      if (/turn off (your )?(microphone|mic)/i.test(l)) return { el: b, muted: false };
      if (/microphone/i.test(l) && b.getAttribute("aria-pressed") != null) return { el: b, muted: b.getAttribute("aria-pressed") === "false" };
    }
    return null;
  }
  function leaveButton(doc) {
    return [...doc.querySelectorAll('button, [role="button"]')].find((b) => /(^|\b)(leave|hang\s*-?up|end)\b.{0,20}(call|meeting|session)?/i.test(`${label(b)} ${text2(b)}`.trim()) && !/leave a message|end of/i.test(label(b))) || null;
  }
  function inCall2(doc) {
    return !!(micButton2(doc) && leaveButton(doc) && !endScreen2(doc));
  }
  function endScreen2(doc) {
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
    * { box-sizing: border-box; font-family: "Google Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap { --ink:#f5f4ff; --dim:#aeaad6; --line:rgba(255,255,255,.12); --ok:#34d399; --warn:#fbbf24; --bad:#fb7185; --saffron:#ffb347;
      display:flex; flex-direction:column; align-items:flex-end; gap:8px; color:var(--ink); }

    /* Capsule */
    .pill { position:relative; display:flex; align-items:center; gap:10px; padding:6px 6px 6px 12px; border-radius:999px;
      background:linear-gradient(135deg,#2f2a8f 0%,#1e1b6b 55%,#17154f 100%);
      border:1px solid rgba(255,255,255,.14);
      box-shadow:0 10px 28px -8px rgba(20,16,90,.65), 0 2px 6px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.18);
      font-size:12px; font-weight:500; line-height:1; cursor:grab; user-select:none; white-space:nowrap; touch-action:none; }
    .pill::before { content:""; position:absolute; left:14px; right:14px; top:2px; height:40%; border-radius:999px;
      background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0)); pointer-events:none; }
    .pill:active { cursor:grabbing; }
    .pill.alert { border-color:rgba(251,113,133,.7); box-shadow:0 10px 28px -8px rgba(251,113,133,.5), 0 2px 6px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.18); }

    .eq { display:flex; align-items:center; gap:2px; height:16px; }
    .eq i { display:block; width:3px; height:4px; border-radius:2px; background:linear-gradient(180deg,#ffd08a,var(--saffron)); }
    .eq.live i { animation:eq 900ms ease-in-out infinite; }
    .eq.live i:nth-child(2) { animation-delay:-.3s; } .eq.live i:nth-child(3) { animation-delay:-.6s; } .eq.live i:nth-child(4) { animation-delay:-.15s; }
    .eq.dead i { background:var(--warn); }
    @keyframes eq { 0%,100% { height:4px; } 50% { height:15px; } }
    .rec { width:7px; height:7px; border-radius:50%; background:var(--bad); box-shadow:0 0 0 0 rgba(251,113,133,.7); animation:ring 1.6s infinite; }
    @keyframes ring { 70% { box-shadow:0 0 0 7px rgba(251,113,133,0); } 100% { box-shadow:0 0 0 0 rgba(251,113,133,0); } }
    .time { font-variant-numeric:tabular-nums; font-weight:650; letter-spacing:.01em; }

    .warn-chip { display:none; align-items:center; gap:4px; padding:5px 9px; border-radius:999px; font-weight:650; font-size:11px;
      background:rgba(251,113,133,.18); color:#ffc2cb; border:1px solid rgba(251,113,133,.5); }
    .warn-chip.show { display:inline-flex; }

    .mic { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:12px; font-weight:650; cursor:pointer; color:#fff;
      border:1px solid transparent; border-radius:999px; padding:7px 12px 7px 9px; transition:transform .1s, filter .15s, background .2s; }
    .mic:hover { filter:brightness(1.12); } .mic:active { transform:scale(.95); }
    .mic:disabled { opacity:.5; cursor:default; }
    .mic svg { width:14px; height:14px; flex:none; }
    .mic.on { background:linear-gradient(180deg,#34d399,#10b981); color:#052e22; }
    .mic.off { background:rgba(255,255,255,.1); border-color:var(--line); color:var(--dim); }
    .mic.paused { background:linear-gradient(180deg,#fcd34d,#f59e0b); color:#3b2600; }

    /* Detail card */
    .panel { width:276px; padding:14px 15px 15px; border-radius:18px; color:var(--ink);
      background:linear-gradient(160deg,rgba(40,35,125,.96),rgba(22,20,82,.97)); backdrop-filter:blur(16px) saturate(1.4);
      border:1px solid rgba(255,255,255,.14); box-shadow:0 20px 50px -14px rgba(10,8,60,.75), 0 3px 8px rgba(0,0,0,.3); font-size:12px; }
    .panel h4 { margin:0 0 10px; font-size:13px; font-weight:700; display:flex; align-items:center; gap:7px; }
    .panel h4 b { color:var(--saffron); }
    .meter { margin:7px 0 9px; }
    .meter .top { display:flex; justify-content:space-between; color:var(--dim); margin-bottom:4px; }
    .meter .top span:last-child { color:var(--ink); font-weight:600; }
    .bar { height:6px; border-radius:4px; background:rgba(255,255,255,.1); overflow:hidden; }
    .fill { height:100%; border-radius:4px; background:linear-gradient(90deg,#34d399,#6ee7b7); transition:width .3s; }
    .fill.low { background:linear-gradient(90deg,#f59e0b,#fcd34d); } .fill.dead { background:var(--bad); }
    .stats { display:flex; gap:8px; margin:10px 0; }
    .stat { flex:1; padding:8px 10px; border-radius:11px; background:rgba(255,255,255,.07); border:1px solid var(--line); }
    .stat b { display:block; font-size:17px; font-weight:700; margin-bottom:2px; }
    .stat span { color:var(--dim); font-size:11px; }
    .stat.err b { color:var(--bad); }

    .alertbox { margin:10px 0; padding:10px 11px; border-radius:12px; background:rgba(251,113,133,.14); border:1px solid rgba(251,113,133,.5); }
    .alertbox.key { background:rgba(251,191,36,.12); border-color:rgba(251,191,36,.5); }
    .alertbox strong { display:flex; justify-content:space-between; align-items:center; font-size:12px; margin-bottom:4px; color:#ffd0d6; }
    .alertbox.key strong { color:#fde68a; }
    .alertbox p { margin:0; color:#e9e6ff; font-size:11.5px; line-height:1.45; }
    .alertbox button { all:unset; cursor:pointer; color:var(--dim); font-size:15px; line-height:1; padding:0 2px; }

    .switch { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:12px 0 2px; cursor:pointer; color:#e9e6ff; }
    .switch input { display:none; }
    .track { position:relative; flex:none; width:34px; height:19px; border-radius:999px; background:rgba(255,255,255,.18); transition:background .2s; }
    .track::after { content:""; position:absolute; left:2px; top:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:transform .2s; box-shadow:0 1px 3px rgba(0,0,0,.4); }
    .switch input:checked + .track { background:var(--ok); } .switch input:checked + .track::after { transform:translateX(15px); }

    .stop { width:100%; margin-top:13px; padding:9px; border-radius:11px; border:0; font:inherit; font-weight:700; font-size:12.5px; cursor:pointer; color:#fff;
      background:linear-gradient(180deg,#fb7185,#e11d48); box-shadow:0 6px 14px -6px rgba(225,29,72,.7); }
    .stop:hover { filter:brightness(1.08); }
    .hint { color:var(--dim); font-size:11px; margin-top:8px; line-height:1.4; }
    .hidden { display:none !important; }
  `;
    const MIC_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    const MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>';
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
    const meetMuted = () => app.micButton(document)?.muted ?? null;
    let myTab = null;
    let S = { rec: { recording: false }, levels: null, counts: { segs: 0, errs: 0 }, follow: true };
    let host;
    let pill;
    let eq;
    let timeEl;
    let micBtn;
    let warnChip;
    let panel;
    let expanded = false;
    let hover = false;
    let lastSentMute;
    let panelSig = "";
    async function load() {
      const r = await send({ type: "pill-state" });
      if (r?.ok) S = r;
    }
    function mount() {
      host = document.createElement("div");
      host.setAttribute("data-debrief", "");
      let pos = { right: 16, bottom: 92 };
      try {
        pos = JSON.parse(localStorage.getItem(POS_KEY)) || pos;
      } catch {
      }
      host.style.cssText = `position:fixed;right:${pos.right}px;bottom:${pos.bottom}px;z-index:2147483646;display:none;`;
      const root = host.attachShadow({ mode: "open" });
      const style = el("style");
      style.textContent = CSS;
      const wrap = el("div", "wrap");
      panel = el("div", "panel hidden");
      pill = el("div", "pill");
      eq = el("span", "eq");
      eq.append(el("i"), el("i"), el("i"), el("i"));
      timeEl = el("span", "time", "00:00");
      warnChip = el("span", "warn-chip", "\u26A0 Limit");
      micBtn = el("button", "mic");
      micBtn.type = "button";
      pill.append(el("span", "rec"), eq, timeEl, warnChip, micBtn);
      wrap.append(panel, pill);
      root.append(style, wrap);
      document.documentElement.appendChild(host);
      micBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      micBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await send({ type: "mic", on: !(S.rec.micWanted ?? S.rec.micOn) });
        await load();
        render();
      });
      wrap.addEventListener("mouseenter", () => {
        hover = true;
        render();
      });
      wrap.addEventListener("mouseleave", () => {
        hover = false;
        render();
      });
      drag(pill);
    }
    function drag(target) {
      let st = null;
      target.addEventListener("pointerdown", (e) => {
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
        st.moved = true;
        host.style.right = Math.max(0, Math.min(innerWidth - 60, st.right - dx)) + "px";
        host.style.bottom = Math.max(0, Math.min(innerHeight - 30, st.bottom - dy)) + "px";
      });
      target.addEventListener("pointerup", () => {
        if (!st) return;
        if (st.moved) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({ right: parseInt(host.style.right, 10), bottom: parseInt(host.style.bottom, 10) }));
          } catch {
          }
        } else {
          expanded = !expanded;
          render();
        }
        st = null;
      });
    }
    const label2 = (v) => v == null ? "off" : v < 3e-3 ? "silent" : v < 0.012 ? "very quiet" : "good";
    function meter(name, v) {
      const box = el("div", "meter");
      const top = el("div", "top");
      top.append(el("span", null, name), el("span", null, label2(v)));
      const b = el("div", "bar");
      const f = el("div", "fill" + (v != null && v < 3e-3 ? " dead" : v != null && v < 0.012 ? " low" : ""));
      f.style.width = (v == null ? 0 : Math.min(100, Math.round(Math.sqrt(v) * 160))) + "%";
      b.append(f);
      box.append(top, b);
      return box;
    }
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
      eq.classList.toggle("dead", !fresh);
      const alert = rec.alert;
      pill.classList.toggle("alert", !!alert);
      warnChip.classList.toggle("show", !!alert);
      warnChip.textContent = alert?.kind === "key" ? "\u26A0 API key" : "\u26A0 Limit";
      const wanted = rec.micWanted ?? rec.micOn;
      const paused = wanted && !rec.micOn;
      micBtn.className = "mic " + (!rec.mic ? "off" : paused ? "paused" : wanted ? "on" : "off");
      micBtn.innerHTML = (wanted && !paused ? MIC_ON : MIC_OFF) + (!rec.mic ? "No mic" : paused ? "Muted" : wanted ? "Mic on" : "Mic off");
      micBtn.disabled = !rec.mic;
      micBtn.title = !rec.mic ? "Microphone not available to Debrief" : paused ? "Meet is muted, so Debrief is ignoring your mic. Click to stop including it." : wanted ? "Your mic is in the transcript. Click to ignore it." : "Your mic is ignored. Click to include it.";
      const open = expanded || hover;
      panel.classList.toggle("hidden", !open);
      if (!open) {
        panelSig = "";
        return;
      }
      const sig = JSON.stringify([peak > 0 ? Math.round(lv.tab * 1e3) : 0, fresh && rec.micOn ? Math.round((lv.mic || 0) * 1e3) : -1, S.counts, S.follow, alert?.at, !!fresh]);
      if (sig === panelSig) return;
      panelSig = sig;
      panel.replaceChildren();
      const h = el("h4");
      h.append("Debrief ", el("b", null, "is recording"));
      panel.append(h);
      if (alert) {
        const box = el("div", "alertbox " + alert.kind);
        const strong = el("strong");
        strong.append(el("span", null, `\u26A0 ${alert.title}`));
        const x = el("button", null, "\xD7");
        x.title = "Dismiss";
        x.onclick = async () => {
          await send({ type: "dismiss-alert" });
          await load();
          render();
        };
        strong.append(x);
        box.append(strong, el("p", null, alert.detail));
        panel.append(box);
      }
      panel.append(meter("Meeting audio", fresh ? lv.tab : null), meter("Your mic", fresh && rec.micOn ? lv.mic : null));
      const stats = el("div", "stats");
      const a = el("div", "stat");
      a.append(el("b", null, String(S.counts.segs)), el("span", null, "transcript segments"));
      stats.append(a);
      if (S.counts.errs) {
        const b = el("div", "stat err");
        b.append(el("b", null, String(S.counts.errs)), el("span", null, "chunks failed"));
        stats.append(b);
      }
      panel.append(stats);
      const sw = el("label", "switch");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = S.follow;
      cb.onchange = async () => {
        await send({ type: "set-follow", on: cb.checked });
        await load();
        render();
      };
      sw.append(el("span", null, "Ignore my mic while Meet is muted"), cb, el("span", "track"));
      panel.append(sw);
      if (!fresh) panel.append(el("div", "hint", "No audio data is arriving. If this stays, stop and start the recording again."));
      const stop = el("button", "stop", "Stop & write MOM");
      stop.onclick = () => send({ type: "stop" });
      panel.append(stop);
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
      if (endedHits === 2) send({ type: "meet-ended" });
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
            fresh.push({ name: c.name, text: c.text, t });
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
