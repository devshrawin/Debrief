(() => {
  // src/store.js
  var DEFAULTS = {
    myName: "",
    captureMic: true,
    meetingLanguage: "auto",
    // auto | hinglish | malayalam
    miniWindow: true,
    // open the controller window when recording starts
    pillOnPage: false,
    // also show the pill inside the Meet page
    followMeetMute: true,
    // ignore my mic while Meet's own mic button is muted
    momLanguage: "English",
    geminiKey: "",
    // shared by Gemini transcription and the Gemini MOM writer
    geminiKey2: "",
    // optional backup key from a different Google Cloud project
    sttProvider: "gemini",
    // gemini | sarvam | deepgram | openai
    sttGeminiModel: "gemini-3.5-transcribe",
    sarvamKey: "",
    sarvamModel: "saaras:v4",
    sarvamMode: "codemix",
    // codemix | transcribe | translate
    sarvamLanguage: "unknown",
    deepgramKey: "",
    deepgramModel: "nova-3",
    sttBase: "https://api.groq.com/openai/v1",
    sttKey: "",
    sttModel: "whisper-large-v3",
    sttPrompt: "Hinglish office meeting. Hindi in Devanagari, English words in English.",
    llmProvider: "gemini",
    // gemini | anthropic | openai
    anthropicKey: "",
    anthropicModel: "claude-opus-5-5",
    oaBase: "https://api.openai.com/v1",
    oaKey: "",
    oaModel: "",
    geminiModel: "gemini-3.8-flash"
  };
  async function getSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    return { ...DEFAULTS, ...settings || {} };
  }
  function sttReady(s) {
    if (s.sttProvider === "gemini") return !!s.geminiKey && !!s.sttGeminiModel;
    if (s.sttProvider === "sarvam") return !!s.sarvamKey;
    if (s.sttProvider === "deepgram") return !!s.deepgramKey;
    return !!s.sttBase && !!s.sttModel;
  }
  function llmReady(s) {
    if (s.llmProvider === "anthropic") return !!s.anthropicKey && !!s.anthropicModel;
    if (s.llmProvider === "gemini") return !!s.geminiKey && !!s.geminiModel;
    return !!s.oaBase && !!s.oaModel;
  }
  var key = (id) => `meeting:${id}`;
  async function getMeeting(id) {
    const r = await chrome.storage.local.get(key(id));
    return r[key(id)] || null;
  }
  async function listMeetings() {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    const r = await chrome.storage.local.get(meetingIds.map(key));
    return meetingIds.map((id) => r[key(id)]).filter(Boolean);
  }
  async function deleteMeeting(id) {
    const { meetingIds = [] } = await chrome.storage.local.get("meetingIds");
    await chrome.storage.local.set({ meetingIds: meetingIds.filter((x) => x !== id) });
    await chrome.storage.local.remove(key(id));
  }
  async function getState() {
    const { rec } = await chrome.storage.session.get("rec");
    return rec || { recording: false };
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor(sec % 3600 / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // src/popup.js
  var $ = (id) => document.getElementById(id);
  var send = (msg) => chrome.runtime.sendMessage({ target: "bg", ...msg });
  var levelWord = (v) => v == null ? "off" : v < 3e-3 ? "silent" : v < 0.012 ? "very quiet" : "good";
  function setMeter(barId, textId, v) {
    const bar = $(barId);
    bar.style.width = v == null ? "0%" : `${Math.min(100, Math.round(Math.sqrt(v) * 160))}%`;
    bar.className = v != null && v < 3e-3 ? "dead" : v != null && v < 0.012 ? "low" : "";
    $(textId).textContent = levelWord(v);
  }
  async function refresh() {
    const st = await getState();
    const recording = st.recording && !st.stopping;
    $("dot").classList.toggle("rec", !!st.recording);
    $("statusText").textContent = st.stopping ? "Finishing transcription\u2026" : st.recording ? "Recording" : "Idle";
    $("timer").textContent = st.recording ? fmtTime((Date.now() - st.startedAt) / 1e3) : "";
    $("start").classList.toggle("hidden", !!st.recording);
    $("stop").classList.toggle("hidden", !recording);
    $("live").classList.toggle("hidden", !st.recording);
    $("micRow").classList.toggle("hidden", !(recording && st.mic));
    const wanted = !!(st.micWanted ?? st.micOn);
    $("micToggle").checked = wanted;
    $("micState").textContent = wanted && !st.micOn ? "Paused: Meet is muted" : wanted ? "Your voice goes into the transcript" : "Your voice is ignored";
    $("micWarn").classList.toggle("hidden", !(st.recording && st.micError));
    $("micWarn").textContent = st.micError ? `Only other participants are being recorded. ${st.micError}` : "";
    const a = st.recording ? st.alert : null;
    $("alert").classList.toggle("hidden", !a);
    if (a) {
      $("alert").className = `alert ${a.kind}`;
      $("alertTitle").textContent = `\u26A0 ${a.title}`;
      $("alertText").textContent = a.detail;
    }
    const { levels } = await chrome.storage.session.get("levels");
    const fresh = st.recording && levels && Date.now() - levels.at < 4e3;
    $("eq").classList.toggle("live", !!fresh && Math.max(levels.tab || 0, levels.mic || 0) >= 0.012);
    if (st.recording) {
      if (fresh) {
        setMeter("lvTab", "lvTabT", levels.tab);
        setMeter("lvMic", "lvMicT", st.micOn ? levels.mic : null);
      } else {
        setMeter("lvTab", "lvTabT", null);
        setMeter("lvMic", "lvMicT", null);
        $("lvTabT").textContent = "no data: recorder not running, stop and restart";
      }
      const m = await getMeeting(st.meetingId);
      const n = m?.segments.length || 0;
      const errs = m?.errors.length || 0;
      $("segInfo").textContent = `${n} transcript segment${n === 1 ? "" : "s"} so far${errs ? ` \xB7 ${errs} failed chunk${errs === 1 ? "" : "s"} (kept, see MOM page)` : ""}. First one lands after ~2\u20133 min.`;
    }
  }
  var armed = null;
  async function renderRecent() {
    const items = await listMeetings();
    $("clearAll").classList.toggle("hidden", !items.length);
    if (!items.length) {
      $("recent").replaceChildren(Object.assign(document.createElement("p"), { className: "hint", textContent: "None yet." }));
      return;
    }
    const st = await getState();
    $("recent").replaceChildren(
      ...items.slice(0, 6).map((m) => {
        const row = document.createElement("div");
        row.className = "item";
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = m.title;
        const small = document.createElement("small");
        small.textContent = ` \xB7 ${new Date(m.startedAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}`;
        a.append(small);
        a.onclick = (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: chrome.runtime.getURL(`mom.html?id=${m.id}`) });
        };
        const del = document.createElement("button");
        del.className = "del";
        del.textContent = "\u2715";
        del.title = "Delete this meeting";
        const live = st.recording && st.meetingId === m.id;
        del.disabled = live;
        if (live) del.style.display = "none";
        del.onclick = async () => {
          if (armed !== m.id) {
            armed = m.id;
            del.className = "del armed";
            del.textContent = "Delete?";
            setTimeout(() => {
              if (armed === m.id) {
                armed = null;
                del.className = "del";
                del.textContent = "\u2715";
              }
            }, 3e3);
            return;
          }
          armed = null;
          await deleteMeeting(m.id);
          renderRecent();
        };
        row.append(a, del);
        return row;
      })
    );
  }
  $("clearAll").onclick = async () => {
    const b = $("clearAll");
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Click again to delete all";
      setTimeout(() => {
        b.dataset.armed = "";
        b.textContent = "Clear all";
      }, 3e3);
      return;
    }
    const st = await getState();
    for (const m of await listMeetings()) if (!(st.recording && st.meetingId === m.id)) await deleteMeeting(m.id);
    b.dataset.armed = "";
    b.textContent = "Clear all";
    renderRecent();
  };
  $("popOut").onclick = () => send({ type: "open-mini" });
  $("alertX").onclick = () => send({ type: "dismiss-alert" }).then(refresh);
  $("start").onclick = async () => {
    $("start").disabled = true;
    try {
      $("error").classList.add("hidden");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await send({ type: "start", streamId, tabId: tab.id, title: tab.title, url: tab.url });
      if (!r?.ok) throw new Error(r?.error || "unknown error");
    } catch (e) {
      $("error").textContent = `Could not start: ${e.message}`;
      $("error").classList.remove("hidden");
    } finally {
      $("start").disabled = false;
      refresh();
    }
  };
  $("stop").onclick = async () => {
    $("stop").disabled = true;
    await send({ type: "stop" });
    window.close();
  };
  $("micToggle").onchange = (e) => send({ type: "mic", on: e.target.checked }).then(refresh);
  for (const id of ["openSettings", "openSettings1"]) {
    $(id).onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    };
  }
  (async () => {
    const s = await getSettings();
    const ready = sttReady(s) && llmReady(s);
    $("setup").classList.toggle("hidden", ready);
    $("start").disabled = !sttReady(s);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/^https:\/\/meet\.google\.com\//.test(tab?.url || "")) $("start").textContent = "Record this tab (not a Meet tab)";
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "toggle-recording");
    $("shortcutHint").innerHTML = cmd?.shortcut ? `Shortcut: <kbd>${cmd.shortcut.split("+").join("</kbd>+<kbd>")}</kbd> starts/stops \xB7 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> mic on/off` : "Set a start/stop shortcut at chrome://extensions/shortcuts.";
    await refresh();
    await renderRecent();
    setInterval(refresh, 1e3);
  })();
})();
