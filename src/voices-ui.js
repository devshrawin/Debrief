// The Voices page in Settings: add people, record about 20 seconds, play it back, save only the fingerprint,
// rename, re-record, delete, and forget everything. The recording lives in memory until saved or cancelled.
import { getSettings, setSetting, getVoices, saveVoices, forgetAllVoices, listMeetings, fmtTime, getBlockedVoices, saveBlockedVoices } from './store.js';
import { unnamedGroups, isAnon, mergePeople, blockEntry, LEARN } from './voice/learn.js';
import { createVoiceClient } from './voice/client.js';
import { buildPrint, upsertPerson, addRecording, speechPieces, PROMPTS, ENROL, SR } from './voice/enrol.js';
import { exportVoices, parseImport, mergeImport } from './voice/share.js';
import { encodeWav } from './wav.js';
import { modal } from './modal.js';
import { getSample, putSample, deleteSample, hasSample, makeClip, unnamedKey } from './voice/samples.js';

const OKBTN = [{ label: 'OK', value: 'ok', primary: true }];
const tell = (text) => modal({ text, buttons: OKBTN });

const $ = (id) => document.getElementById(id);
const MAX_SEC = 40;

let people = [];
let mode = { kind: 'new', id: null }; // new | rerecord | add
let lang = 'en';
let pcm = null; // the recording, in memory only
let audioUrl = '';
let rec = null; // { ctx, stream, node, blocks, started, timer }
let client = null;

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

// kind: '' (neutral) | 'info' | 'warn' | 'bad' | 'ok'. `true` means 'bad', as older callers pass it.
const setMsg = (t, kind = '') => {
  $('enrolMsg').textContent = t;
  $('enrolMsg').className = `msgbox ${kind === true ? 'bad' : kind || ''}`.trim();
};
const READY_MSG = 'Type a name, then press Record and read the text above. Use the mic you use in meetings.';
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// The recorder buttons follow the state: nothing to play or save until there is a recording.
let saving = false;
function syncEnrol() {
  $('enrolRec').hidden = !!rec;
  $('enrolStop').hidden = !rec;
  $('enrolDot').hidden = !rec;
  $('enrolPlay').disabled = !pcm;
  $('enrolSave').disabled = !pcm || saving;
}

function getClient() {
  if (!client) {
    client = createVoiceClient({
      workerUrl: chrome.runtime.getURL('dist/worker.js'),
      modelUrl: chrome.runtime.getURL('models/wespeaker_resnet34_lm.onnx'),
      wasmPaths: chrome.runtime.getURL('vendor/ort/'),
      maxQueue: 64,
    });
  }
  return client;
}

function closeClient() {
  client?.close();
  client = null;
}

const LANG_NAME = { en: 'English', hi: 'Hindi', ml: 'Malayalam', free: 'free speech' };
const ORDER = ['en', 'hi', 'ml', 'free'];
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function badgeOf(p) {
  if (!p.auto) return ['Recorded', 'brand'];
  if (isAnon(p)) return ['Unnamed voice', ''];
  if (p.confirmed) return ['Named by you, in use', 'ok'];
  return p.ready ? ['Learned, in use', 'ok'] : ['Learned, still learning', 'warn'];
}

// One "More" menu open at a time: Export, Merge, Delete.
let openMenu = null;
function closeMenu(refocus) {
  if (!openMenu) return;
  const { menu, more } = openMenu;
  openMenu = null;
  menu.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  if (refocus) more.focus();
}

function moreMenu(p, items) {
  const more = el('button', { type: 'button', className: 'btn sm', textContent: 'More ▾' });
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', `More actions for ${p.name}`);
  const menu = el('div', { className: 'menu', hidden: true });
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `More actions for ${p.name}`);
  const btns = items.map(({ label, fn, danger, aria }) => {
    const b = el('button', { type: 'button', className: danger ? 'danger' : '', textContent: label });
    b.setAttribute('role', 'menuitem');
    if (aria) b.setAttribute('aria-label', aria);
    b.onclick = () => {
      closeMenu(true);
      fn();
    };
    return b;
  });
  menu.append(...btns);
  menu.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') btns[(i + 1) % btns.length].focus();
    else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length].focus();
    else if (e.key === 'Escape') closeMenu(true);
    else if (e.key === 'Tab') closeMenu(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  });
  more.onclick = () => {
    const wasOpen = openMenu?.menu === menu;
    closeMenu(false);
    if (wasOpen) return;
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    openMenu = { menu, more };
    btns[0].focus();
  };
  return [more, menu];
}

function renderList() {
  closeMenu(false);
  stopPlaying();
  $('voiceEmpty').hidden = people.length > 0;
  $('hPeople').textContent = people.length ? `Enrolled people · ${people.length}` : 'Enrolled people';
  $('voiceList').replaceChildren(
    ...people.map((p) => {
      const anon = p.auto && isAnon(p);
      const [badge, cls] = badgeOf(p);
      const langs = (p.langs || [p.lang || 'en']).map((l) => LANG_NAME[l] || l).join(' + ');
      const n = p.meetings || 1;
      const meta = p.auto
        ? `${anon ? 'Heard in your meetings, not named yet' : 'Learned from your meetings'} · ${n} meeting${n === 1 ? '' : 's'} · ${p.secs || 0} s of clean speech${p.ready || p.confirmed ? '' : ` · not used yet, needs ${LEARN.readySecs} s from ${LEARN.readyMeetings} meetings, or give it a name`}${anon && !samplesOn ? ' · no audio clip (switch on “Keep a short sample” before the next meeting). Meanwhile open that meeting’s Transcript: this voice’s lines are labelled with this name, so you can name it by reading what it said.' : ''}`
        : `${langs} · ${p.secs || '?'} s of speech · added ${fmtDate(p.created)}`;
      const row = el('li', { className: 'voice-row' });
      const initial = anon ? '?' : (Array.from(p.name.trim())[0] || '?').toUpperCase();
      const avatar = el('span', { className: `avatar${anon ? ' anon' : ''}`, textContent: initial });
      avatar.setAttribute('aria-hidden', 'true');
      const who = el('div', { className: 'vwho' }, el('div', { className: 'vtop' }, el('strong', { className: 'vn', textContent: p.name }), el('span', { className: `chip ${cls}`.trim(), textContent: badge })), el('p', { className: 'hint vm', textContent: meta }));
      const btn = (label, fn) => el('button', { type: 'button', className: 'btn sm', textContent: label, onclick: fn });
      const items = [{ label: 'Export this voice', fn: () => download(exportVoices(people, [p.id]), `debrief-voice-${p.name.replace(/[^\w-]+/g, '_')}.json`) }];
      if (p.auto && people.length > 1) items.push({ label: 'Merge into…', fn: () => mergeInto(p) });
      items.push({ label: 'Delete', aria: `Delete ${p.name}`, fn: () => remove(p), danger: true });
      const acts = el('div', { className: 'vacts' }, sampleButton(p), btn(anon ? 'Name this voice' : 'Rename', () => rename(p)), ...(anon ? [] : [btn('Re-record', () => begin({ kind: 'rerecord', id: p.id }, p)), btn('Add recording', () => begin({ kind: 'add', id: p.id }, p))]), ...moreMenu(p, items));
      row.append(avatar, who, acts);
      return row;
    })
  );
}

// "Play sample": a short clip of any voice, only when sample keeping is on and a clip exists.
let playing = null;
let playingUrl = '';
function stopPlaying() {
  playing?.pause();
  playing = null;
  if (playingUrl) URL.revokeObjectURL(playingUrl);
  playingUrl = '';
}
function sampleButton(p) {
  const b = el('button', { type: 'button', className: 'btn sm primary', hidden: true }, el('span', { className: 'tri' }), 'Play sample');
  b.setAttribute('aria-label', `Play sample of ${p.name}`);
  hasSample(p.id).then((yes) => (b.hidden = !yes)).catch(() => {});
  b.onclick = async () => {
    if (b.dataset.busy) return;
    b.dataset.busy = '1';
    try {
      stopPlaying();
      const blob = await getSample(p.id);
      if (!blob) return (b.hidden = true);
      playingUrl = URL.createObjectURL(blob);
      playing = new Audio(playingUrl);
      playing.onended = stopPlaying;
      await playing.play();
    } catch {
      // a clip that cannot be played (corrupt) is dropped, so the button does not promise something that fails
      stopPlaying();
      b.hidden = true;
      deleteSample(p.id).catch(() => {});
    } finally {
      delete b.dataset.busy;
    }
  };
  return b;
}

let samplesOn = false;
async function refresh() {
  samplesOn = !!(await getSettings()).voiceSamples;
  people = await getVoices();
  renderList();
  renderUnnamed().catch(() => {});
}

// Voices in the latest meeting that match nobody: name them in one step.
async function renderUnnamed() {
  const meetings = (await listMeetings()).filter((m) => (m.voiceSegs || []).length >= 20).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const m = meetings[0];
  const groups = m ? unnamedGroups(m, people) : [];
  $('unnamedCard').hidden = !groups.length;
  if (m) $('unnamedSub').textContent = `${m.title || 'Your latest meeting'}${m.startedAt ? ` · ${fmtDate(m.startedAt)}` : ''}. Name a voice once and it is recognised next time.`;
  $('unnamedList').replaceChildren(
    ...groups.map((g, i) => {
      const label = el('label', { className: 'sr-only', htmlFor: `unnamedName${i}`, textContent: `Name for Voice ${i + 1}` });
      const input = el('input', { id: `unnamedName${i}`, placeholder: 'Who is this?', maxLength: 60, autocomplete: 'off' });
      const save = el('button', { type: 'button', className: 'btn primary', textContent: 'Name this voice' });
      const doSave = async () => {
        try {
          people = upsertPerson(people, { name: input.value, lang: 'free', print: { centroid: g.centroid, windows: g.windows, speechSec: g.seconds } });
          await saveVoices(people);
          // the named voice keeps its clip, so "Play sample" works in the list
          const named = people.find((x) => x.name.toLowerCase() === input.value.trim().replace(/\s+/g, ' ').toLowerCase());
          getSample(key).then((b) => b && named && putSample(named.id, b)).catch(() => {});
          renderList();
          renderUnnamed();
        } catch (e) {
          tell(e.message);
        }
      };
      save.onclick = doSave;
      input.onkeydown = (e) => e.key === 'Enter' && doSave();
      // a short clip of this voice, kept after the meeting so you can hear who it is
      const key = unnamedKey(m.id, g.at[0]);
      const play = el('button', { type: 'button', className: 'btn sm', hidden: true }, el('span', { className: 'tri' }), 'Play');
      play.setAttribute('aria-label', `Play a clip of Voice ${i + 1}`);
      hasSample(key).then((yes) => (play.hidden = !yes)).catch(() => {});
      play.onclick = async () => {
        try {
          stopPlaying();
          const blob = await getSample(key);
          if (!blob) return (play.hidden = true);
          playingUrl = URL.createObjectURL(blob);
          playing = new Audio(playingUrl);
          playing.onended = stopPlaying;
          await playing.play();
        } catch {
          stopPlaying();
        }
      };
      return el(
        'li',
        {},
        el('div', { className: 'ut' }, el('strong', { textContent: `Voice ${i + 1}` }), el('span', { className: 'hint', textContent: `spoke ${g.seconds} s` })),
        el('p', { className: 'hint', textContent: `For example at ${g.at.map(fmtTime).join(', ')}` }),
        el('div', { className: 'name-row' }, play, label, input, save)
      );
    })
  );
}

async function rename(p) {
  const r = await modal({ text: `New name for ${p.name}`, input: { value: isAnon(p) ? '' : p.name, placeholder: 'Their name', maxLength: 60 }, buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Rename', value: 'ok', primary: true }] });
  if (!r || r.value !== 'ok') return;
  try {
    const clean = r.input.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) throw new Error('A name cannot be empty.');
    if (people.some((x) => x.id !== p.id && x.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already a voice called ${clean}.`);
    // naming a learned voice confirms it: it is used from now on, including for meetings already recorded
    people = people.map((x) => (x.id === p.id ? { ...x, name: clean, ...(x.auto ? { confirmed: true } : {}) } : x));
    await saveVoices(people);
    renderList();
    const st = await getSettings();
    if (!st.voiceOn) {
      const on = await modal({ text: `${clean} is saved. Naming speakers by voice is switched off, so transcripts and minutes will not use the name yet. Turn it on?`, buttons: [{ label: 'Not now', value: 'no' }, { label: 'Turn on', value: 'yes', primary: true }] });
      if (on?.value === 'yes') await setSetting({ voiceOn: true });
    }
  } catch (e) {
    tell(e.message);
  }
}

async function remove(p) {
  const buttons = [{ label: 'Cancel', value: 'no' }, { label: 'Delete', value: 'del', danger: true }];
  if (p.auto) buttons.push({ label: 'Delete and never learn it again', value: 'block', danger: true });
  const r = await modal({ text: `Delete the voice of ${p.name}? Their fingerprint is removed from this browser.${p.auto ? '\n\nThis voice was learned from your meetings, so Debrief may learn it again after another meeting unless you choose "never learn it again".' : ''}`, buttons });
  if (!r || r.value === 'no') return;
  try {
    if (r.value === 'block') {
      await saveBlockedVoices([...(await getBlockedVoices()), blockEntry(p)]);
      renderBlocked();
    }
    people = people.filter((x) => x.id !== p.id);
    await saveVoices(people);
    deleteSample(p.id).catch(() => {});
    renderList();
  } catch (e) {
    tell(`Could not delete: ${e.message}`);
  }
}

// Two learned voices that are really one person (for example a laptop and a headset): fold one into the other.
async function mergeInto(p) {
  const others = people.filter((x) => x.id !== p.id);
  const r = await modal({ text: `Merge ${p.name} into which voice? The result keeps that voice's name.`, select: others.map((x) => ({ value: x.id, label: x.name })), buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Merge', value: 'ok', primary: true }] });
  if (!r || r.value !== 'ok') return;
  try {
    people = mergePeople(people, p.id, r.select);
    await saveVoices(people);
    // the clip moves to the voice it was merged into when that one has none
    const mine = await getSample(p.id).catch(() => null);
    if (mine && !(await hasSample(r.select).catch(() => true))) await putSample(r.select, mine).catch(() => {});
    deleteSample(p.id).catch(() => {});
    renderList();
  } catch (e) {
    tell(e.message);
  }
}

async function renderBlocked() {
  const blocked = await getBlockedVoices();
  $('voiceBlockedRow').hidden = !blocked.length;
  $('voiceBlockedMsg').textContent = `${blocked.length} learned voice${blocked.length === 1 ? ' is' : 's are'} set never to be learned again.`;
}

function resetRecording() {
  stopCapture(true);
  pcm = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = '';
  $('enrolRec').textContent = 'Record';
  $('enrolLevel').style.width = '0';
  $('enrolTime').textContent = '';
  syncEnrol();
}

// Back to a blank "Add a person" form.
function blankForm() {
  mode = { kind: 'new', id: null };
  resetRecording();
  $('enrolName').value = '';
  $('enrolName').disabled = false;
  $('enrolTitle').textContent = 'Add a person';
}

function begin(m, person) {
  resetRecording();
  mode = m;
  $('enrolTitle').textContent = m.kind === 'new' ? 'Add a person' : m.kind === 'rerecord' ? `Re-record ${person.name}` : `Add another recording for ${person.name}`;
  $('enrolName').value = person ? person.name : '';
  $('enrolName').disabled = !!person;
  setLang(m.kind === 'add' ? ORDER.find((l) => !(person.langs || [person.lang || 'en']).includes(l)) || 'free' : lang);
  setMsg(m.kind === 'add' ? 'Record in another language this person uses in meetings: it makes the voice recognisable in each.' : READY_MSG, m.kind === 'add' ? 'info' : '');
  (person ? $('enrolRec') : $('enrolName')).scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  (person ? $('enrolRec') : $('enrolName')).focus({ preventScroll: true });
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function setLang(l) {
  lang = l;
  $('enrolPrompt').textContent = PROMPTS[l];
  $('enrolPrompt').lang = l === 'free' ? 'en' : l;
  document.querySelectorAll('#enrolLang button').forEach((b) => {
    const on = b.dataset.lang === l;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

// ---- recording ----
async function startCapture() {
  if (rec) return;
  setMsg('');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const ctx = new AudioContext({ sampleRate: SR });
  await ctx.audioWorklet.addModule('worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  const r = { ctx, stream, node, blocks: [], started: Date.now(), timer: 0, peak: 0 };
  node.port.onmessage = (e) => {
    const b = e.data;
    r.blocks.push(b);
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    const rms = Math.sqrt(s / b.length);
    r.peak = Math.max(r.peak, rms);
    // roughly -50 dB (silence) .. -10 dB (loud talking) across the meter
    const db = 20 * Math.log10(rms + 1e-9);
    $('enrolLevel').style.width = `${Math.max(0, Math.min(100, ((db + 50) / 40) * 100))}%`;
  };
  r.timer = setInterval(() => {
    const sec = (Date.now() - r.started) / 1000;
    $('enrolTime').textContent = `${clock(sec)}${sec < ENROL.targetSec ? '' : ' ✓'}`;
    if (sec >= MAX_SEC) finishCapture();
  }, 250);
  rec = r;
  syncEnrol();
}

function stopCapture(discard) {
  if (!rec) return null;
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close().catch(() => {});
  if (discard) return null;
  const len = r.blocks.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const b of r.blocks) {
    out.set(b, o);
    o += b.length;
  }
  return { pcm: out, peak: r.peak };
}

function finishCapture() {
  const got = stopCapture(false);
  $('enrolRec').textContent = 'Record again';
  $('enrolLevel').style.width = '0';
  syncEnrol();
  if (!got || got.pcm.length < SR * 3) {
    setMsg('That was too short. Press Record and read the text above.', 'warn');
    return;
  }
  if (got.peak < 0.005) {
    setMsg('Almost nothing was picked up. Check that the right microphone is selected in Chrome, then record again.', 'bad');
    return;
  }
  pcm = got.pcm;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(new Blob([encodeWav(pcm, SR)], { type: 'audio/wav' }));
  $('enrolTime').textContent = clock(pcm.length / SR);
  syncEnrol();
  setMsg('Play it back to check it is clear, then save. Nothing is stored until you press Save voice.', 'ok');
}

async function save() {
  if (!pcm) return;
  const name = $('enrolName').value;
  try {
    if (mode.kind === 'new') upsertPerson(people, { name, lang, print: { centroid: '', windows: [], speechSec: 0 } }); // validate the name before the slow part
    saving = true;
    syncEnrol();
    setMsg('Working out the voice fingerprint… (the first time this loads the speaker model)', 'info');
    const c = getClient();
    await Promise.race([c.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The speaker model did not load. Reload this page and try again.')), 60000))]);
    const print = await buildPrint(pcm, (p) => c.embed(p));
    if (!print.ok) {
      setMsg(print.reason, 'warn');
      return;
    }
    const keep = !!(await getSettings()).voiceSamples;
    let newId = mode.id;
    if (mode.kind === 'new') {
      people = upsertPerson(people, { name, lang, print });
      newId = people[people.length - 1].id;
    } else if (mode.kind === 'rerecord') people = upsertPerson(people, { id: mode.id, name, lang, print });
    else people = addRecording(people, mode.id, { lang, print });
    await saveVoices(people);
    // a short clip of the speech, so the voice can be played back here later (only while "Keep short samples" is on)
    let clipOk = false;
    if (keep && newId && (mode.kind !== 'add' || !(await hasSample(newId)))) {
      const best = speechPieces(pcm).sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0)).map((x) => x.pcm);
      clipOk = await putSample(newId, makeClip(best.length ? best : [pcm])).then(() => true, () => false);
    }
    const done = `Saved ${name.trim()}: ${print.pieces} pieces of speech, ${print.speechSec.toFixed(0)} s. ${clipOk ? 'The fingerprint and a short audio clip you can play were stored.' : 'Only the fingerprint was stored.'}${print.warn ? ` ${print.warn}` : ''}`;
    blankForm();
    setMsg(done, 'ok');
    renderList();
  } catch (e) {
    setMsg(e.message, 'bad');
  } finally {
    saving = false;
    syncEnrol();
  }
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importFile(file) {
  const out = $('voiceShareMsg');
  try {
    if (file.size > 2e6) throw new Error('That file is too large to be a voices file.');
    const { people: incoming, problems } = parseImport(await file.text());
    if (!incoming.length) {
      out.textContent = problems[0] || 'Nothing to import.';
      return;
    }
    const clash = incoming.filter((p) => people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())).map((p) => p.name);
    const ans = clash.length ? await modal({ text: `${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} already enrolled here. Replace with the imported voice?`, buttons: [{ label: 'Keep mine', value: 'keep' }, { label: 'Replace', value: 'replace', primary: true }] }) : null;
    const replace = ans?.value === 'replace';
    const r = mergeImport(people, incoming, { replace });
    people = r.list;
    await saveVoices(people);
    renderList();
    out.textContent = `Imported ${r.added.length} new${r.replaced.length ? `, replaced ${r.replaced.length}` : ''}${r.skipped.length ? `, kept your existing ${r.skipped.join(', ')}` : ''}.${problems.length ? ` ${problems.join(' ')}` : ''} Imported voices are only as good as the original recording: check them on a real meeting.`;
  } catch (e) {
    out.textContent = e.message;
  }
}

export async function initVoices() {
  await refresh();
  setLang('en');
  const langBtns = [...document.querySelectorAll('#enrolLang button')];
  langBtns.forEach((b, i) => {
    b.onclick = () => setLang(b.dataset.lang);
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = langBtns[(i + d + langBtns.length) % langBtns.length];
      setLang(next.dataset.lang);
      next.focus();
    });
  });
  // the "More" menus close on an outside click
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.more.contains(e.target)) closeMenu(false);
  });
  $('enrolJump').onclick = () => {
    $('enrol').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    $('enrolName').focus({ preventScroll: true });
  };
  setMsg(READY_MSG);
  syncEnrol();
  $('enrolRec').onclick = async () => {
    try {
      if (pcm) pcm = null;
      syncEnrol();
      if (mode.kind === 'new' && !$('enrolName').value.trim()) {
        setMsg('Type the person’s name first.', 'bad');
        $('enrolName').focus();
        return;
      }
      await startCapture();
      $('enrolStop').focus();
      setMsg('Listening… keep going until about 20 seconds.', 'info');
    } catch (e) {
      setMsg(e.name === 'NotAllowedError' ? 'The microphone is blocked. Use “Allow microphone” on the General page, then try again.' : e.name === 'NotFoundError' ? 'No microphone is available. Allow it in General, under Microphone, or plug one in.' : `Could not start the microphone: ${e.message}`, 'bad');
    }
  };
  $('enrolStop').onclick = () => {
    finishCapture();
    $('enrolPlay').disabled ? $('enrolRec').focus() : $('enrolPlay').focus();
  };
  $('enrolPlay').onclick = () => audioUrl && new Audio(audioUrl).play();
  $('enrolSave').onclick = save;
  $('enrolCancel').onclick = () => {
    blankForm();
    setMsg(READY_MSG);
  };
  $('voiceExport').onclick = () => (people.length ? download(exportVoices(people), 'debrief-voices.json') : ($('voiceShareMsg').textContent = 'Nobody is enrolled yet.'));
  $('voiceImport').onclick = () => $('voiceImportFile').click();
  $('voiceImportFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  };
  renderBlocked();
  $('voiceAllowAgain').onclick = async () => {
    await saveBlockedVoices([]);
    renderBlocked();
  };
  $('voiceForget').onclick = async () => {
    const ok = await modal({ text: 'Forget all voices? This deletes every enrolled fingerprint and the voice fingerprints saved with past meetings. It cannot be undone.', buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Forget all voices', value: 'yes', danger: true }] });
    if (ok?.value !== 'yes') return;
    const n = await forgetAllVoices();
    people = [];
    renderList();
    closeClient();
    setMsg(`All voices forgotten${n ? ` (and fingerprints removed from ${n} saved meeting${n === 1 ? '' : 's'})` : ''}.`, 'ok');
  };
  chrome.storage.onChanged.addListener((c) => {
    if (c.voices) refresh();
  });
  window.addEventListener('pagehide', () => {
    stopCapture(true);
    closeClient();
  });
}
