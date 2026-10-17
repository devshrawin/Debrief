import { DEFAULTS, getSettings, saveSettings, ensureEmailSecret, AMNEX_PRESET } from './store.js';
import { isLocalBase } from './local.js';
import { generate } from './llm.js';
import { sendMail, mailReady, parseAddresses, parseGroups, scriptWithAllowList, scriptWithSecret, allowListLines } from './mailer.js';
import scriptText from '../apps-script/Code.gs';
import { OLLAMA_BASE, WHISPER_BASE, listOllamaModels, ollamaContext, contextAdvice, explain } from './local.js';
import { learnAlias } from './dictionary.js';
import { LANGUAGES, chosenLanguages, minutesLanguageOptions, joinNames } from './languages.js';
import { initVoices } from './voices-ui.js';
import { runCheckup, checkupText } from './checkup.js';
import { summarize, parseLimits, parsePrices, estimateCost, paidCost, paidTotal, rupees, rate, nextQuotaReset, istClock } from './usage.js';
import { modal } from './modal.js';

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

// ---- secrets ----
// A key that is already saved is never rendered: the field shows dots and a Replace button. `stored` holds the
// keys as last loaded or saved, so saving without touching a field writes nothing and cannot erase a stored key.
const SECRETS = ['geminiKey', 'geminiKey2', 'sarvamKey', 'deepgramKey', 'sttKey', 'anthropicKey', 'oaKey'];
const stored = {};
const removed = new Set(); // "Remove" pressed: the key is deleted on the next save
const editing = new Set(); // "Replace" pressed: an empty field is open
const secretUi = {};

function secretValue(k) {
  const v = $(k).value.trim();
  return v || (removed.has(k) ? '' : stored[k] || '');
}

function renderSecret(k) {
  const u = secretUi[k];
  if (!u) return;
  const input = $(k);
  const has = !!stored[k] && !removed.has(k);
  const masked = has && !editing.has(k);
  u.mask.hidden = !masked;
  input.hidden = masked;
  u.replace.hidden = !masked;
  u.keep.hidden = !((has && editing.has(k)) || removed.has(k));
  u.keep.textContent = removed.has(k) ? 'Undo remove' : 'Keep current';
  u.remove.hidden = !(has && editing.has(k));
  u.note.hidden = false;
  u.note.replaceChildren();
  if (masked) u.note.append(el('span', { className: 'chip ok', textContent: 'Saved' }), 'On this computer only. Never shown again.');
  else if (removed.has(k)) u.note.append('The key will be removed when you press Save changes.');
  else if (has) u.note.append('Type the new key. Leave it empty, or press Escape, to keep the current one.');
  else u.note.hidden = true;
}

function renderSecrets() {
  SECRETS.forEach(renderSecret);
}

function initSecrets() {
  for (const k of SECRETS) {
    const input = $(k);
    if (!input) continue;
    const label = document.querySelector(`label[for="${k}"]`);
    if (label && !label.id) label.id = `${k}-lbl`;
    const name = label ? label.firstChild.textContent.trim() : 'key';
    const mask = el('div', { className: 'secret-mask', textContent: '••••••••••••' });
    mask.setAttribute('role', 'img');
    mask.setAttribute('aria-label', `${name}: saved, hidden`);
    const replace = el('button', { type: 'button', className: 'btn', textContent: 'Replace' });
    replace.setAttribute('aria-label', `Replace ${name.toLowerCase()}`);
    const keep = el('button', { type: 'button', className: 'btn ghost', textContent: 'Keep current' });
    const remove = el('button', { type: 'button', className: 'btn ghost', textContent: 'Remove' });
    remove.style.color = 'var(--rec-ink)';
    remove.setAttribute('aria-label', `Remove ${name.toLowerCase()}`);
    const note = el('p', { className: 'secret-note' });
    input.before(mask);
    input.after(replace, keep, remove, note);
    secretUi[k] = { mask, replace, keep, remove, note };
    replace.onclick = () => {
      editing.add(k);
      renderSecret(k);
      input.focus();
    };
    const revert = () => {
      removed.delete(k);
      editing.delete(k);
      input.value = '';
      renderSecret(k);
      replace.focus();
      updateDirty();
    };
    keep.onclick = revert;
    remove.onclick = () => {
      removed.add(k);
      editing.add(k);
      input.value = '';
      renderSecret(k);
      keep.focus();
      updateDirty();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && stored[k] && !input.hidden) {
        e.preventDefault();
        revert();
      }
    });
  }
}

// Empty a saved key on purpose (for example when switching to a local server that needs none).
function clearSecret(k) {
  $(k).value = '';
  if (stored[k]) {
    removed.add(k);
    editing.add(k);
  }
  renderSecret(k);
}

function read() {
  const s = {};
  for (const k of FIELDS) {
    const f = $(k);
    if (!f) continue;
    s[k] = SECRETS.includes(k) ? secretValue(k) : f.type === 'checkbox' ? f.checked : f.value.trim();
  }
  s.shareMode = $('shareAuto').checked ? 'auto' : 'review';
  s.meetingLanguages = [...document.querySelectorAll('#langChips input:checked')].map((c) => c.dataset.lang);
  return s;
}

// Put values into the fields (page load, and Undo).
function fill(s) {
  for (const k of FIELDS) {
    const f = $(k);
    if (!f) continue;
    if (SECRETS.includes(k)) {
      stored[k] = s[k] || '';
      f.value = '';
    } else if (f.type === 'checkbox') f.checked = !!s[k];
    else f.value = s[k] ?? '';
  }
  removed.clear();
  editing.clear();
  $('shareAuto').checked = s.shareMode === 'auto';
  renderSecrets();
}

// ---- segmented controls that drive a hidden <select> ----
const MODE_NOTE = {
  thorough: 'Finds every item first, writes the minutes, then checks that nothing was missed.',
  quick: 'One pass over the transcript. Lighter on a free quota; may miss small items in long meetings.',
};
function arrowKeys(buttons, pick) {
  buttons.forEach((b, i) => {
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = buttons[(i + d + buttons.length) % buttons.length];
      next.focus();
      pick(next);
    });
  });
}
function initSegs() {
  document.querySelectorAll('[data-seg-for]').forEach((box) => {
    const sel = $(box.dataset.segFor);
    const btns = [...box.querySelectorAll('button')];
    const sync = () => {
      btns.forEach((b) => {
        const on = b.dataset.v === sel.value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      if (sel.id === 'minutesMode') $('minutesModeNote').textContent = MODE_NOTE[sel.value] || '';
    };
    const pick = (b) => {
      sel.value = b.dataset.v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    btns.forEach((b) => (b.onclick = () => pick(b)));
    arrowKeys(btns, pick);
    sel.addEventListener('change', sync);
    box._sync = sync;
    sync();
  });
}
const syncSegs = () => document.querySelectorAll('[data-seg-for]').forEach((b) => b._sync());

// Left-hand navigation: one page at a time, remembered in the URL hash.
function showTab(name) {
  if (!document.getElementById(`page-${name}`)) name = 'start';
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  document.querySelectorAll('#nav button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
}
document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-go]').forEach((a) => (a.onclick = () => showTab(a.dataset.go)));

// ---- learned names and suggested fixes ----
async function renderLearned() {
  const { learned } = await chrome.storage.local.get('learned');
  const names = Object.keys(learned?.names || {});
  $('learnedNames').textContent = names.length ? names.slice(-60).join(', ') : 'None yet. Names are learned from your meetings.';
  const pending = learned?.pending || [];
  $('pendingEmpty').classList.toggle('hidden', pending.length > 0);
  $('pendingList').replaceChildren(
    ...pending.map((p) => {
      const row = el('div', { className: 'prow' });
      const t = el('span', { className: 'who' }, el('b', { textContent: p.suggest }), ' was heard as ', el('b', { textContent: p.found }));
      const meta = el('span', { className: 'hint', textContent: `${p.count}× · ${p.meeting || 'a meeting'}` });
      const ok = el('button', { type: 'button', className: 'btn sm primary', textContent: 'Fix it from now on' });
      const no = el('button', { type: 'button', className: 'btn sm', textContent: 'Dismiss' });
      ok.onclick = async () => {
        $('dictionary').value = learnAlias($('dictionary').value, p.suggest, p.found);
        await save();
        await chrome.storage.local.set({ learned: { ...learned, pending: pending.filter((x) => x.id !== p.id) } });
      };
      no.onclick = async () => chrome.storage.local.set({ learned: { ...learned, pending: pending.filter((x) => x.id !== p.id), rejected: [...(learned.rejected || []), p.id] } });
      row.append(t, meta, ok, no);
      return row;
    })
  );
}
$('clearLearned').onclick = async () => {
  const { learned } = await chrome.storage.local.get('learned');
  await chrome.storage.local.set({ learned: { ...learned, names: {} } });
};
chrome.storage.onChanged.addListener((c) => {
  if (c.learned) renderLearned();
});

// ---- usage page ----
let usageDays = 1;
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const KIND = { stt: 'Speech to text', llm: 'Minutes' };
const RANGE = { 1: 'today', 7: 'in the last 7 days', 30: 'in the last 30 days' };
const money = (usd) => (usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2));

async function renderUsage() {
  const { usage, learnedLimits = {} } = await chrome.storage.local.get(['usage', 'learnedLimits']);
  const settings = await getSettings();
  const typed = parseLimits($('usageLimits').value || settings.usageLimits);
  const limits = { ...learnedLimits, ...typed };
  const rows = summarize(usage, usageDays);
  const prices = parsePrices($('usagePrices').value || settings.usagePrices);
  const today = summarize(usage, 1);
  const table = $('usageTable');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  [
    ['Service and model', ''],
    ['Used for', ''],
    ['Requests', 'num'],
    ['Failed (rate limit)', 'num'],
    ['Tokens in / out', 'num'],
    ['Audio', 'num'],
    ['Cost if paid', 'num'],
    [usageDays === 1 ? 'Left today (estimate)' : '', ''],
  ].forEach(([h, cls]) => head.append(Object.assign(document.createElement('th'), { textContent: h, className: cls })));
  const body = table.createTBody();
  if (!rows.length) {
    const r = body.insertRow();
    const c = r.insertCell();
    c.colSpan = 8;
    c.textContent = 'Nothing yet. Counts start with your next recording.';
    c.style.color = 'var(--muted)';
  }
  for (const r of rows) {
    const tr = body.insertRow();
    const cell = (t, cls) => Object.assign(tr.insertCell(), { textContent: t, className: cls || '' });
    const svc = tr.insertCell();
    svc.append(el('span', { className: 'svc', textContent: r.provider }));
    if (r.model && r.model !== '-') svc.append(el('span', { className: 'sr-only', textContent: ' · ' }), el('div', { className: 'hint', textContent: r.model }));
    cell(KIND[r.kind] || r.kind);
    cell(String(r.req), 'num');
    cell(r.fail ? `${r.fail}${r.rl ? ` (${r.rl} limit)` : ''}` : '0', `num${r.fail ? ' fail' : ''}`);
    cell(r.tin || r.tout ? `${fmtN(r.tin)} / ${fmtN(r.tout)}` : '-', 'num');
    cell(r.audioSec ? `${Math.round(r.audioSec / 60)} min` : '-', 'num');
    const paid = paidCost(r, prices);
    cell(paid.usd == null ? '-' : r.fail && !r.tin && !r.tout ? rupees(0, $('usdInr').value) : `${paid.assumed ? '~' : ''}${rupees(paid.usd, $('usdInr').value)}`, 'num cost');
    const left = tr.insertCell();
    left.className = 'usage-left';
    const limit = limits[r.model];
    if (usageDays === 1 && limit) {
      const used = today.filter((x) => x.model === r.model).reduce((a, x) => a + x.req, 0);
      const remaining = Math.max(0, limit - used);
      const pct = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
      const meter = el('div', { className: 'meter' }, el('i', { className: pct === 0 ? 's' : pct <= 20 ? 'q' : '' }));
      meter.firstChild.style.width = `${pct}%`;
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-valuenow', String(pct));
      meter.setAttribute('aria-label', `${r.model} left today`);
      left.append(meter, el('div', { className: `hint${pct <= 20 ? ' low' : ''}`, textContent: `${remaining} of ${limit} left` }));
    } else if (usageDays === 1) left.append(el('span', { className: 'hint', textContent: 'No daily limit' }));
  }
  const reqs = rows.reduce((a, r) => a + r.req, 0);
  const audio = rows.filter((r) => r.kind === 'stt').reduce((a, r) => a + r.audioSec, 0);
  const cost = estimateCost(rows, prices);
  const paid = paidTotal(rows, prices);
  $('usageTotals').replaceChildren(
    el('strong', { textContent: `Total ${RANGE[usageDays] || ''}`.trim() }),
    el('span', { textContent: `${reqs} requests` }),
    el('span', { textContent: `${Math.round(audio / 60)} min of audio transcribed` }),
    ...(cost != null ? [el('span', { textContent: `about ${rupees(cost, $('usdInr').value)} at your prices` })] : []),
    el('span', { className: 'paid', textContent: `if this were paid: about ${rupees(paid.usd, $('usdInr').value)}${paid.assumed ? ' (Gemini Flash list prices assumed where you set none)' : ''}${paid.unknown ? `, ${paid.unknown} line(s) unpriced` : ''}` }),
    el('span', { className: 'hint', style: 'margin-left:auto', textContent: `Daily quota resets at ${istClock(nextQuotaReset())} (midnight Pacific)` })
  );
}

const rangeBtns = [...document.querySelectorAll('#usageRange button')];
const pickRange = (b) => {
  usageDays = Number(b.dataset.days);
  rangeBtns.forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-selected', String(x === b));
    x.tabIndex = x === b ? 0 : -1;
  });
  renderUsage();
};
rangeBtns.forEach((b) => {
  b.onclick = () => pickRange(b);
  b.tabIndex = b.classList.contains('active') ? 0 : -1;
});
arrowKeys(rangeBtns, pickRange);
$('usageReset').onclick = async () => {
  const r = await modal({ text: "Reset all usage counters? This only clears Debrief's own tally.", buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Reset counters', value: 'yes', danger: true }] });
  if (r?.value !== 'yes') return;
  await chrome.storage.local.remove(['usage', 'learnedLimits']);
  renderUsage();
};
$('usageLimits').addEventListener('input', renderUsage);
$('usagePrices').addEventListener('input', renderUsage);
$('usdInr').addEventListener('input', renderUsage);
chrome.storage.onChanged.addListener((c) => {
  if (c.usage || c.learnedLimits) renderUsage();
});

function showProviderFields() {
  document.querySelectorAll('[data-stt]').forEach((f) => f.classList.toggle('hidden', f.dataset.stt !== $('sttProvider').value));
  document.querySelectorAll('[data-llm]').forEach((f) => f.classList.toggle('hidden', f.dataset.llm !== $('llmProvider').value));
}

// Custom base URLs need a host permission so the extension can call them without CORS trouble.
async function requestOrigins(s) {
  const urls = [];
  if (s.sttProvider === 'openai') urls.push(s.sttBase);
  if (s.llmProvider === 'openai') urls.push(s.oaBase);
  const origins = [];
  for (const u of urls) {
    // Keys travel in the request, so anything that is not this computer must use https.
    if (u && !isLocalBase(u) && !/^https:\/\//i.test(u)) throw new Error(`Use an https address for ${u}. Only addresses on this computer may use http.`);
    try {
      origins.push(`${new URL(u).origin}/*`);
    } catch {
      throw new Error(`Invalid base URL: ${u}`);
    }
  }
  if (!origins.length || (await chrome.permissions.contains({ origins }))) return;
  if (!(await chrome.permissions.request({ origins }))) throw new Error('Permission for the custom endpoint was denied.');
}

// ---- languages: pick any number ----
function buildLanguageUi() {
  $('langChips').replaceChildren(
    ...LANGUAGES.map((l) => {
      const label = document.createElement('label');
      label.className = 'pick';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.lang = l.code;
      cb.onchange = langHint;
      label.append(cb, l.name);
      return label;
    })
  );
  $('momLanguage').replaceChildren(...minutesLanguageOptions().map((o) => Object.assign(document.createElement('option'), { value: o.value, textContent: o.label })));
}
function setLanguageCodes(codes) {
  const set = new Set(codes);
  document.querySelectorAll('#langChips input').forEach((c) => (c.checked = set.has(c.dataset.lang)));
  langHint();
}
function setLanguages(s) {
  setLanguageCodes((chosenLanguages(s) || []).map((l) => l.code));
}
function langHint() {
  const picked = LANGUAGES.filter((l) => document.querySelector(`#langChips input[data-lang="${l.code}"]`)?.checked);
  $('langHint').textContent = picked.length
    ? `Debrief will expect ${joinNames(picked)}, in any mix. Fewer choices give more accurate text.`
    : 'Nothing selected: automatic (Hindi, English and Malayalam are expected, and others are detected). Pick the languages your meetings really use for better accuracy.';
}

// Values as last loaded or saved. Only fields the user changed on this page are written, on top of the
// latest stored settings, so an old open tab can never wipe a change made somewhere else (a remembered
// name fix, the email secret, a mute switch).
let loaded = {};
let ready = false;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function save() {
  const vals = read();
  const out = { ...(await getSettings()) };
  for (const k of Object.keys(vals)) if (!same(vals[k], loaded[k])) out[k] = vals[k];
  await requestOrigins(out);
  await saveSettings(out);
  loaded = vals;
  for (const k of SECRETS) if ($(k)) stored[k] = vals[k];
  removed.clear();
  editing.clear();
  for (const k of SECRETS) if ($(k)) $(k).value = '';
  renderSecrets();
  updateDirty();
  return out;
}

// ---- the sticky save bar: unsaved changes, Undo, Saved feedback ----
let flash = null;
let flashTimer = 0;
const isDirty = () => {
  if (!ready) return false;
  const v = read();
  return Object.keys(v).some((k) => !same(v[k], loaded[k]));
};
function updateDirty() {
  const bar = $('savebar');
  const dirty = isDirty();
  bar.classList.toggle('dirty', dirty && !flash);
  bar.classList.toggle('saved', flash?.kind === 'saved');
  bar.classList.toggle('bad', flash?.kind === 'bad');
  $('undo').hidden = !dirty;
  $('msg').textContent = flash ? flash.text : dirty ? 'You have unsaved changes' : 'All changes saved';
}
function showFlash(kind, text, ms) {
  flash = { kind, text };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = null;
    updateDirty();
  }, ms);
  updateDirty();
}
function applyValues(v) {
  fill(v);
  setLanguageCodes(v.meetingLanguages || []);
  showProviderFields();
  syncSegs();
  renderAllow();
  renderUsage();
}
document.querySelector('.content').addEventListener('input', () => {
  if (flash?.kind === 'saved') flash = null;
  updateDirty();
});
document.querySelector('.content').addEventListener('change', () => {
  if (flash?.kind === 'saved') flash = null;
  updateDirty();
});
$('undo').onclick = () => {
  applyValues(loaded);
  updateDirty();
  $('save').focus();
};

async function micStatus() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    $('micStatus').textContent = p.state === 'granted' ? 'Microphone allowed ✓' : `Microphone: ${p.state}`;
    $('micStatus').classList.toggle('ok', p.state === 'granted');
  } catch {}
}

$('sttProvider').onchange = showProviderFields;
$('llmProvider').onchange = showProviderFields;

$('save').onclick = async () => {
  try {
    await save();
    showFlash('saved', 'Saved ✓', 3000);
    updateGuide();
  } catch (e) {
    showFlash('bad', e.message, 7000);
  }
};

$('grantMic').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    $('micStatus').textContent = `Not allowed: ${e.message}`;
    return;
  }
  micStatus();
  updateGuide();
};

// ---- local models ----
$('useOllama').onclick = () => {
  $('llmProvider').value = 'openai';
  showProviderFields();
  $('oaBase').value = OLLAMA_BASE;
  clearSecret('oaKey');
  $('localStatus').textContent = 'Set to Ollama (http://localhost:11434/v1). Press "Find my installed models" to pick one.';
  updateDirty();
};

$('findOllama').onclick = async () => {
  $('localStatus').textContent = 'Looking for Ollama…';
  const base = $('oaBase').value.trim() || OLLAMA_BASE;
  const r = await listOllamaModels(base);
  if (!r.ok) {
    $('ollamaPick').classList.add('hidden');
    $('localStatus').textContent = r.message;
    return;
  }
  const sel = $('ollamaModels');
  sel.replaceChildren(...r.models.map((m) => Object.assign(document.createElement('option'), { value: m.name, textContent: `${m.name}${m.sizeGB ? ` (${m.sizeGB} GB)` : ''}` })));
  if (r.models.some((m) => m.name === $('oaModel').value)) sel.value = $('oaModel').value;
  $('ollamaPick').classList.remove('hidden');
  const pick = async () => {
    $('oaBase').value = base;
    $('oaModel').value = sel.value;
    updateDirty();
    const ctx = await ollamaContext(sel.value, base);
    $('localStatus').textContent = `Using ${sel.value}. ${contextAdvice(ctx)}`;
  };
  sel.onchange = pick;
  await pick();
};

$('useWhisper').onclick = () => {
  $('sttProvider').value = 'openai';
  showProviderFields();
  $('sttBase').value = WHISPER_BASE;
  clearSecret('sttKey');
  $('whisperStatus').textContent = 'Set to http://localhost:8000/v1. Change the address if your server uses another port.';
  updateDirty();
};

$('testWhisper').onclick = async () => {
  $('whisperStatus').textContent = 'Testing…';
  const base = ($('sttBase').value.trim() || WHISPER_BASE).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(6000) });
    $('whisperStatus').textContent = res.ok ? 'The server answered ✓' : explain(null, res.status, 'The server');
  } catch (e) {
    $('whisperStatus').textContent = explain(e, 0, 'the server');
  }
};

$('testLlm').onclick = async () => {
  $('llmStatus').textContent = 'Testing…';
  try {
    const settings = await save();
    const ping = (s) => generate({ settings: s, system: 'You are a connectivity test.', user: 'Reply with exactly: OK', onText: () => {} });
    // Test each Gemini key on its own so a dead backup key doesn't hide behind a working main key.
    const runs = [['Main', { ...settings, geminiKey2: '' }]];
    if (settings.llmProvider === 'gemini' && settings.geminiKey2) runs.push(['Backup', { ...settings, geminiKey: settings.geminiKey2, geminiKey2: '' }]);
    const results = [];
    for (const [label, s] of runs) {
      try {
        const text = await ping(s);
        results.push(`${label}: works ✓ ("${text.trim().slice(0, 20)}")`);
      } catch (e) {
        results.push(`${label}: failed: ${e.message.slice(0, 150)}`);
      }
    }
    $('llmStatus').textContent = results.join(' · ');
  } catch (e) {
    $('llmStatus').textContent = `Failed: ${e.message}`;
  }
};

// Tick the getting-started steps as the settings fill in.
async function updateGuide() {
  const s = await getSettings();
  const mic = await navigator.permissions.query({ name: 'microphone' }).then((p) => p.state === 'granted').catch(() => false);
  const needsGemini = s.sttProvider === 'gemini' || s.llmProvider === 'gemini';
  const langs = (chosenLanguages(s) || []).map((l) => l.name).join(', ');
  const done = { g1: !!s.geminiKey || !needsGemini, g2: mic, g3: !!s.myName, g4: mailReady(s) };
  const text = {
    g1: done.g1 ? (s.geminiKey ? 'Gemini key saved' : 'No Gemini key needed: you use other services') : 'Add your Gemini key',
    g2: done.g2 ? 'Microphone allowed' : 'Allow your microphone',
    g3: done.g3 ? `Name and languages: ${s.myName} · ${langs || 'automatic'}` : 'Set your name and languages',
    g4: done.g4 ? 'Email is set up' : 'Email the minutes to yourself',
  };
  for (const [id, ok] of Object.entries(done)) {
    const row = $(id);
    if (!row) continue;
    row.classList.toggle('done', ok);
    row.querySelector('.ic').textContent = ok ? '✓' : id.slice(1);
    row.querySelector('[data-text]').textContent = text[id];
    row.querySelector('[data-state]').textContent = ok ? 'Done. ' : 'Not done. ';
    const opt = row.querySelector('[data-opt]');
    if (opt) opt.hidden = ok;
  }
  const n = Object.values(done).filter(Boolean).length;
  $('startLede').textContent = n === 4 ? 'Everything is set up. Debrief is ready to record your next meeting.' : `Four things make Debrief work. ${['None', 'One', 'Two', 'Three'][n]} ${n === 1 ? 'is' : 'are'} done.`;
}
$('g1go').onclick = () => {
  showTab('start');
  const f = $('geminiKey');
  (f.hidden ? secretUi.geminiKey.replace : f).focus();
};

// People to allow in the script: default list plus every recurring-meeting list.
function allAllowed() {
  return parseAddresses([$('shareList').value, ...parseGroups($('shareGroups').value).map((g) => g.list.join(','))].join(','));
}
function renderAllow() {
  const l = allowListLines(allAllowed(), { domains: $('shareDomains').checked });
  $('allowLines').textContent = `const ALLOWED = ${l.allowed};\nconst ALLOWED_DOMAINS = ${l.domains};`;
}
['shareList', 'shareGroups'].forEach((id) => $(id).addEventListener('input', renderAllow));
$('shareDomains').addEventListener('change', renderAllow);
$('copyScriptAllow').onclick = async () => {
  await navigator.clipboard.writeText(scriptWithAllowList(scriptText, allAllowed(), { domains: $('shareDomains').checked, secret: await ensureEmailSecret() }));
  $('copyAllowMsg').textContent = 'Copied. Paste it over your script, save, then deploy a new version.';
  setTimeout(() => ($('copyAllowMsg').textContent = ''), 6000);
};

$('scriptText').textContent = scriptText;
$('copyScript').onclick = async () => {
  await navigator.clipboard.writeText(scriptWithSecret(scriptText, await ensureEmailSecret()));
  $('copyMsg').textContent = 'Copied ✓';
  setTimeout(() => ($('copyMsg').textContent = ''), 1500);
};

// ---- Check my setup ----
const LEVEL = { '✓': ['ok', 'Working'], '!': ['warn', 'Warning'], '✗': ['bad', 'Not working'] };
function renderChecks(rows) {
  $('checkupOut').replaceChildren(
    ...rows.map((r) => {
      const [cls, sr] = LEVEL[r.level] || LEVEL['!'];
      const ic = el('span', { className: `ic ${cls}`, textContent: r.level });
      ic.setAttribute('aria-label', sr);
      const name = el('b', {}, r.title, el('span', { className: 'sr-only', textContent: ': ' }));
      const body = el('div', { className: 'ck' }, name);
      if (r.detail) body.append(el('p', { className: 'hint', textContent: r.detail }));
      const li = el('li', {}, ic, body);
      if (r.go && r.level !== '✓') {
        const fix = el('button', { type: 'button', className: 'btn sm', textContent: r.fixText || 'Open settings' });
        fix.onclick = () => showTab(r.go);
        li.append(fix);
      }
      return li;
    })
  );
}
$('checkup').onclick = async () => {
  $('checkup').disabled = true;
  $('checkupMsg').textContent = 'Checking…';
  try {
    const rows = await runCheckup();
    const text = checkupText(rows);
    renderChecks(rows);
    $('checkupOut').hidden = false;
    $('checkupCopy').hidden = false;
    $('checkup').textContent = 'Check again';
    const bad = rows.filter((r) => r.level === '✗').length;
    const warn = rows.filter((r) => r.level === '!').length;
    const summary = bad ? `${bad} problem${bad === 1 ? '' : 's'}, ${warn} to look at` : warn ? `No problems, ${warn} to look at` : 'All good';
    $('checkupMsg').textContent = summary;
    $('checkupCopy').onclick = async () => {
      await navigator.clipboard.writeText(text);
      $('checkupMsg').textContent = `Copied ✓ ${summary}`;
    };
  } catch (e) {
    $('checkupMsg').textContent = `Could not check: ${e.message}`;
  } finally {
    $('checkup').disabled = false;
  }
};

$('testMail').onclick = async () => {
  $('mailMsg').textContent = 'Sending…';
  try {
    const s = await save();
    if (!mailReady(s)) throw new Error(/\/dev(\?|$)/.test(s.emailWebhook || '') ? 'That is the test URL (ends in /dev). Use Deploy → New deployment, and paste the Web app URL that ends in /exec.' : 'Paste the Apps Script web app URL: https://script.google.com/…/exec (company accounts have /a/macros/yourcompany.com/ in it).');
    const r = await sendMail(
      {
        subject: 'Debrief test email',
        html: '<p>This is a test from <b>Debrief</b>. Your minutes will arrive like this.</p>',
        text: 'This is a test from Debrief. Your minutes will arrive like this.',
        attachments: [],
      },
      s
    );
    $('mailMsg').textContent = `Sent to ${r.to} ✓ Check your inbox.`;
  } catch (e) {
    $('mailMsg').textContent = `Failed: ${e.message}`;
  }
};

// Minutes format: a segmented control over a hidden field, read and saved like every other setting.
const fmtSeg = () => document.querySelectorAll('#minutesFormatSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === $('minutesFormat').value));
document.querySelectorAll('#minutesFormatSeg button').forEach((b) => (b.onclick = () => {
  $('minutesFormat').value = b.dataset.v;
  fmtSeg();
}));

// One click fills in the Amnex name, footer line, colour and domain, and picks the template. Nothing is Amnex by default.
$('useAmnexPreset').onclick = () => {
  for (const [k, v] of Object.entries(AMNEX_PRESET)) $(k).value = v;
  $('minutesFormat').value = 'amnex';
  fmtSeg();
  $('presetMsg').textContent = 'Filled in. Press Save changes to keep it.';
};

(async () => {
  const s = await getSettings();
  buildLanguageUi();
  initSecrets();
  initSegs();
  fill(s);
  setLanguages(s);
  fmtSeg();
  loaded = read();
  ready = true;
  showProviderFields();
  syncSegs();
  renderAllow();
  micStatus();
  updateGuide();
  renderUsage();
  renderLearned();
  initVoices();
  updateDirty();
  showTab(location.hash.slice(1) || 'start');
})();

// Settings changed somewhere else (a minutes tab, the popup): show the new values in every field this page
// has not touched, so the page is never a stale picture of the real settings.
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.settings || !ready) return;
  const fresh = await getSettings();
  for (const k of FIELDS) {
    const f = $(k);
    if (!f || !same(read()[k], loaded[k])) continue; // the user is editing this one
    if (SECRETS.includes(k)) {
      stored[k] = fresh[k] || '';
      renderSecret(k);
    } else if (f.type === 'checkbox') f.checked = !!fresh[k];
    else f.value = fresh[k];
    loaded[k] = fresh[k];
  }
  $('shareAuto').checked = fresh.shareMode === 'auto';
  loaded.shareMode = fresh.shareMode;
  fmtSeg();
  if (same(read().meetingLanguages, loaded.meetingLanguages)) {
    setLanguages(fresh);
    loaded.meetingLanguages = read().meetingLanguages;
  }
  syncSegs();
  updateDirty();
  updateGuide();
});
