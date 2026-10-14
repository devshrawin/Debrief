// The Voices page in Settings: add people, record about 20 seconds, play it back, save only the fingerprint,
// rename, re-record, delete, and forget everything. The recording lives in memory until saved or cancelled.
import { getVoices, saveVoices, forgetAllVoices, listMeetings, fmtTime } from './store.js';
import { unnamedGroups, isAnon, LEARN } from './voice/learn.js';
import { createVoiceClient } from './voice/client.js';
import { buildPrint, upsertPerson, addRecording, PROMPTS, ENROL, SR } from './voice/enrol.js';
import { exportVoices, parseImport, mergeImport } from './voice/share.js';
import { encodeWav } from './wav.js';

const $ = (id) => document.getElementById(id);
const MAX_SEC = 40;

let people = [];
let mode = { kind: 'new', id: null }; // new | rerecord | add
let lang = 'en';
let pcm = null; // the recording, in memory only
let audioUrl = '';
let rec = null; // { ctx, stream, node, blocks, started, timer }
let client = null;

const setMsg = (t, bad = false) => {
  $('enrolMsg').textContent = t;
  $('enrolMsg').style.color = bad ? '#b91c1c' : '';
};

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

function renderList() {
  $('voiceEmpty').hidden = people.length > 0;
  $('voiceList').replaceChildren(
    ...people.map((p) => {
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border)';
      const who = document.createElement('div');
      who.style.cssText = 'flex:1;min-width:180px';
      const langs = (p.langs || [p.lang || 'en']).map((l) => LANG_NAME[l] || l).join(' + ');
      who.innerHTML = '<b class="vn"></b><div class="hint vm" style="margin:2px 0 0"></div>';
      who.querySelector('.vn').textContent = p.name;
      who.querySelector('.vm').textContent = p.auto
        ? `${isAnon(p) ? 'Heard in your meetings, not named yet. Rename it to say who it is · ' : 'Learned from meetings · '}${p.meetings || 1} meeting${(p.meetings || 1) === 1 ? '' : 's'} · ${p.secs || 0} s of clean speech · ${p.ready ? 'in use' : `still learning (needs ${LEARN.readySecs} s from ${LEARN.readyMeetings} meetings), not used yet`}`
        : `${langs} · ${p.secs || '?'} s of speech · added ${fmtDate(p.created)}`;
      const btn = (label, fn, danger) => {
        const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: label });
        if (danger) b.style.color = '#b91c1c';
        b.onclick = fn;
        return b;
      };
      row.append(
        who,
        btn('Rename', () => rename(p)),
        btn('Re-record', () => begin({ kind: 'rerecord', id: p.id }, p)),
        btn('Add recording', () => begin({ kind: 'add', id: p.id }, p)),
        btn('Export', () => download(exportVoices(people, [p.id]), `debrief-voice-${p.name.replace(/[^\w-]+/g, '_')}.json`)),
        btn('Delete', () => remove(p), true)
      );
      return row;
    })
  );
}

async function refresh() {
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
  $('unnamedList').replaceChildren(
    ...groups.map((g, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border)';
      const label = document.createElement('div');
      label.style.cssText = 'flex:1;min-width:200px';
      label.innerHTML = '<b></b><div class="hint" style="margin:2px 0 0"></div>';
      label.querySelector('b').textContent = `Voice ${i + 1}`;
      label.querySelector('.hint').textContent = `${g.seconds} s of speech · for example at ${g.at.map(fmtTime).join(', ')}`;
      const input = Object.assign(document.createElement('input'), { placeholder: 'Who is this?', maxLength: 60 });
      input.style.cssText = 'padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--field);width:200px';
      const save = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Save this voice' });
      save.onclick = async () => {
        try {
          people = upsertPerson(people, { name: input.value, lang: 'free', print: { centroid: g.centroid, windows: g.windows, speechSec: g.seconds } });
          await saveVoices(people);
          renderList();
          renderUnnamed();
        } catch (e) {
          alert(e.message);
        }
      };
      row.append(label, input, save);
      return row;
    })
  );
}

async function rename(p) {
  const name = prompt('New name', p.name);
  if (name == null) return;
  try {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) throw new Error('A name cannot be empty.');
    if (people.some((x) => x.id !== p.id && x.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already a voice called ${clean}.`);
    people = people.map((x) => (x.id === p.id ? { ...x, name: clean } : x));
    await saveVoices(people);
    renderList();
  } catch (e) {
    alert(e.message);
  }
}

async function remove(p) {
  if (!confirm(`Delete the voice of ${p.name}? Their fingerprint is removed from this browser.`)) return;
  people = people.filter((x) => x.id !== p.id);
  await saveVoices(people);
  renderList();
}

function resetRecording() {
  stopCapture(true);
  pcm = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = '';
  $('enrolPlay').hidden = true;
  $('enrolSave').hidden = true;
  $('enrolStop').hidden = true;
  $('enrolRec').hidden = false;
  $('enrolRec').textContent = 'Record';
  $('enrolLevel').style.width = '0';
  $('enrolTime').textContent = '';
}

function begin(m, person) {
  resetRecording();
  mode = m;
  $('enrolTitle').textContent = m.kind === 'new' ? 'Add a person' : m.kind === 'rerecord' ? `Re-record ${person.name}` : `Add another recording for ${person.name}`;
  $('enrolName').value = person ? person.name : '';
  $('enrolName').disabled = !!person;
  $('enrolCancel').hidden = m.kind === 'new';
  setLang(m.kind === 'add' ? ORDER.find((l) => !(person.langs || [person.lang || 'en']).includes(l)) || 'free' : lang);
  setMsg(m.kind === 'add' ? 'Record in another language this person uses in meetings: it makes the voice recognisable in each.' : '');
  $('enrolName').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function setLang(l) {
  lang = l;
  $('enrolPrompt').textContent = PROMPTS[l];
  document.querySelectorAll('#enrolLang button').forEach((b) => b.classList.toggle('active', b.dataset.lang === l));
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
    $('enrolTime').textContent = `${sec.toFixed(0)} s${sec < ENROL.targetSec ? ` (aim for about ${ENROL.targetSec})` : ' ✓'}`;
    if (sec >= MAX_SEC) finishCapture();
  }, 250);
  rec = r;
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
  $('enrolStop').hidden = true;
  $('enrolRec').hidden = false;
  $('enrolRec').textContent = 'Record again';
  $('enrolLevel').style.width = '0';
  if (!got || got.pcm.length < SR * 3) {
    setMsg('That was too short. Press Record and read the text above.', true);
    return;
  }
  if (got.peak < 0.005) {
    setMsg('Almost nothing was picked up. Check that the right microphone is selected in Chrome, then record again.', true);
    return;
  }
  pcm = got.pcm;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(new Blob([encodeWav(pcm, SR)], { type: 'audio/wav' }));
  $('enrolPlay').hidden = false;
  $('enrolSave').hidden = false;
  $('enrolTime').textContent = `${(pcm.length / SR).toFixed(0)} s recorded`;
  setMsg('Play it back to check it is clear, then save. Nothing is stored until you press Save.');
}

async function save() {
  if (!pcm) return;
  const name = $('enrolName').value;
  try {
    if (mode.kind === 'new') upsertPerson(people, { name, lang, print: { centroid: '', windows: [], speechSec: 0 } }); // validate the name before the slow part
    $('enrolSave').disabled = true;
    setMsg('Working out the voice fingerprint… (the first time this loads the speaker model)');
    const c = getClient();
    await Promise.race([c.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The speaker model did not load. Reload this page and try again.')), 60000))]);
    const print = await buildPrint(pcm, (p) => c.embed(p));
    if (!print.ok) {
      setMsg(print.reason, true);
      return;
    }
    if (mode.kind === 'new') people = upsertPerson(people, { name, lang, print });
    else if (mode.kind === 'rerecord') people = upsertPerson(people, { id: mode.id, name, lang, print });
    else people = addRecording(people, mode.id, { lang, print });
    await saveVoices(people);
    const done = `Saved ${name.trim()}: ${print.pieces} pieces of speech, ${print.speechSec.toFixed(0)} s. Only the fingerprint was stored.${print.warn ? ` ${print.warn}` : ''}`;
    mode = { kind: 'new', id: null };
    resetRecording();
    $('enrolName').value = '';
    $('enrolName').disabled = false;
    $('enrolTitle').textContent = 'Add a person';
    $('enrolCancel').hidden = true;
    setMsg(done, false);
    renderList();
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    $('enrolSave').disabled = false;
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
    const replace = clash.length > 0 && confirm(`${clash.join(', ')} already enrolled here. Replace with the imported voice?\n\nOK = replace, Cancel = keep what you have.`);
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
  document.querySelectorAll('#enrolLang button').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
  $('enrolRec').onclick = async () => {
    try {
      if (pcm) {
        pcm = null;
        $('enrolPlay').hidden = true;
        $('enrolSave').hidden = true;
      }
      if (mode.kind === 'new' && !$('enrolName').value.trim()) {
        setMsg('Type the person’s name first.', true);
        $('enrolName').focus();
        return;
      }
      await startCapture();
      $('enrolRec').hidden = true;
      $('enrolStop').hidden = false;
      setMsg('Recording… read the text above at a normal pace.');
    } catch (e) {
      setMsg(e.name === 'NotAllowedError' ? 'The microphone is blocked. Use “Allow microphone” on the General page, then try again.' : `Could not start the microphone: ${e.message}`, true);
    }
  };
  $('enrolStop').onclick = finishCapture;
  $('enrolPlay').onclick = () => audioUrl && new Audio(audioUrl).play();
  $('enrolSave').onclick = save;
  $('enrolCancel').onclick = () => {
    mode = { kind: 'new', id: null };
    resetRecording();
    $('enrolName').value = '';
    $('enrolName').disabled = false;
    $('enrolTitle').textContent = 'Add a person';
    $('enrolCancel').hidden = true;
    setMsg('');
  };
  $('voiceExport').onclick = () => (people.length ? download(exportVoices(people), 'debrief-voices.json') : ($('voiceShareMsg').textContent = 'Nobody is enrolled yet.'));
  $('voiceImport').onclick = () => $('voiceImportFile').click();
  $('voiceImportFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  };
  $('voiceForget').onclick = async () => {
    if (!confirm('Forget all voices? This deletes every enrolled fingerprint and the voice fingerprints saved with past meetings. It cannot be undone.')) return;
    const n = await forgetAllVoices();
    people = [];
    renderList();
    closeClient();
    setMsg(`All voices forgotten${n ? ` (and fingerprints removed from ${n} saved meeting${n === 1 ? '' : 's'})` : ''}.`);
  };
  chrome.storage.onChanged.addListener((c) => {
    if (c.voices) refresh();
  });
  window.addEventListener('pagehide', () => {
    stopCapture(true);
    closeClient();
  });
}
