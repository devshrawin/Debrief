import { DEFAULTS, getSettings, saveSettings } from './store.js';
import { isLocalBase } from './local.js';
import { generate } from './llm.js';
import { sendMail, mailReady, parseAddresses, parseGroups, scriptWithAllowList, allowListLines } from './mailer.js';
import scriptText from '../apps-script/Code.gs';
import { OLLAMA_BASE, WHISPER_BASE, listOllamaModels, ollamaContext, contextAdvice, explain } from './local.js';
import { learnAlias } from './dictionary.js';
import { summarize, parseLimits, parsePrices, estimateCost, dayKey } from './usage.js';

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);

function read() {
  const s = {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    s[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  s.shareMode = $('shareAuto').checked ? 'auto' : 'review';
  return s;
}

// Left-hand navigation: one page at a time, remembered in the URL hash.
function showTab(name) {
  if (!document.getElementById(`page-${name}`)) name = 'start';
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
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
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;flex-wrap:wrap';
      const t = document.createElement('span');
      t.innerHTML = `<b></b> was heard as <b></b>`;
      t.children[0].textContent = p.suggest;
      t.children[1].textContent = p.found;
      const meta = document.createElement('span');
      meta.className = 'hint';
      meta.style.margin = '0';
      meta.textContent = `${p.count}× · ${p.meeting || 'a meeting'}`;
      const ok = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Fix it from now on' });
      const no = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Dismiss' });
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

async function renderUsage() {
  const { usage, learnedLimits = {} } = await chrome.storage.local.get(['usage', 'learnedLimits']);
  const settings = await getSettings();
  const typed = parseLimits($('usageLimits').value || settings.usageLimits);
  const limits = { ...learnedLimits, ...typed };
  const rows = summarize(usage, usageDays);
  const today = summarize(usage, 1);
  const table = $('usageTable');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  ['Service', 'Used for', 'Requests', 'Failed', 'Tokens in / out', 'Audio', usageDays === 1 ? 'Left today (estimate)' : ''].forEach((h) => head.append(Object.assign(document.createElement('th'), { textContent: h })));
  const body = table.createTBody();
  if (!rows.length) {
    const r = body.insertRow();
    const c = r.insertCell();
    c.colSpan = 7;
    c.textContent = 'Nothing yet. Counts start with your next recording.';
    c.style.color = 'var(--muted)';
  }
  for (const r of rows) {
    const tr = body.insertRow();
    const cell = (t, cls) => Object.assign(tr.insertCell(), { textContent: t, className: cls || '' });
    cell(`${r.provider}${r.model && r.model !== '-' ? ` · ${r.model}` : ''}`);
    cell(KIND[r.kind] || r.kind);
    cell(String(r.req), 'num');
    cell(r.fail ? `${r.fail}${r.rl ? ` (${r.rl} limit)` : ''}` : '0', 'num');
    cell(r.tin || r.tout ? `${fmtN(r.tin)} / ${fmtN(r.tout)}` : '-', 'num');
    cell(r.audioSec ? `${Math.round(r.audioSec / 60)} min` : '-', 'num');
    const left = tr.insertCell();
    const limit = limits[r.model];
    if (usageDays === 1 && limit) {
      const used = today.filter((x) => x.model === r.model).reduce((a, x) => a + x.req, 0);
      const pct = Math.min(100, Math.round((used / limit) * 100));
      left.innerHTML = `<div>${Math.max(0, limit - used)} of ${limit}</div><div class="meterbar"><i class="${pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''}" style="width:${pct}%"></i></div>`;
    }
  }
  const reqs = rows.reduce((a, r) => a + r.req, 0);
  const audio = rows.filter((r) => r.kind === 'stt').reduce((a, r) => a + r.audioSec, 0);
  const cost = estimateCost(rows, parsePrices($('usagePrices').value || settings.usagePrices));
  $('usageTotals').textContent = `${reqs} requests · ${Math.round(audio / 60)} min of audio transcribed${cost != null ? ` · about $${cost.toFixed(2)} at your prices` : ''} · quota day ${dayKey()} (Pacific)`;
}

document.querySelectorAll('#usageRange button').forEach((b) => {
  b.onclick = () => {
    usageDays = Number(b.dataset.days);
    document.querySelectorAll('#usageRange button').forEach((x) => x.classList.toggle('active', x === b));
    renderUsage();
  };
});
$('usageReset').onclick = async () => {
  if (!confirm("Reset all usage counters? This only clears Debrief's own tally.")) return;
  await chrome.storage.local.remove(['usage', 'learnedLimits']);
  renderUsage();
};
$('usageLimits').oninput = renderUsage;
$('usagePrices').oninput = renderUsage;
chrome.storage.onChanged.addListener((c) => {
  if (c.usage || c.learnedLimits) renderUsage();
});

function showProviderFields() {
  document.querySelectorAll('[data-stt]').forEach((el) => el.classList.toggle('hidden', el.dataset.stt !== $('sttProvider').value));
  document.querySelectorAll('[data-llm]').forEach((el) => el.classList.toggle('hidden', el.dataset.llm !== $('llmProvider').value));
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

// Values as last loaded or saved. Only fields the user changed on this page are written, on top of the
// latest stored settings, so an old open tab can never wipe a change made somewhere else (a remembered
// name fix, the email secret, a mute switch).
let loaded = {};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function save() {
  const vals = read();
  const out = { ...(await getSettings()) };
  for (const k of Object.keys(vals)) if (!same(vals[k], loaded[k])) out[k] = vals[k];
  await requestOrigins(out);
  await saveSettings(out);
  loaded = vals;
  return out;
}

async function micStatus() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    $('micStatus').textContent = p.state === 'granted' ? 'Microphone allowed ✓' : `Microphone: ${p.state}`;
  } catch {}
}

$('sttProvider').onchange = showProviderFields;
$('llmProvider').onchange = showProviderFields;

$('save').onclick = async () => {
  try {
    await save();
    $('msg').textContent = 'Saved ✓';
    updateGuide();
  } catch (e) {
    $('msg').textContent = e.message;
  }
  setTimeout(() => ($('msg').textContent = ''), 3000);
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
};

// ---- local models ----
$('useOllama').onclick = () => {
  $('llmProvider').value = 'openai';
  showProviderFields();
  $('oaBase').value = OLLAMA_BASE;
  $('oaKey').value = '';
  $('localStatus').textContent = 'Set to Ollama (http://localhost:11434/v1). Press "Find my installed models" to pick one.';
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
  $('sttKey').value = '';
  $('whisperStatus').textContent = 'Set to http://localhost:8000/v1. Change the address if your server uses another port.';
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
  const done = { g1: !!s.geminiKey || (s.sttProvider !== 'gemini' && s.llmProvider !== 'gemini'), g2: mic, g3: !!s.myName, g4: mailReady(s) };
  for (const [id, ok] of Object.entries(done)) $(id)?.classList.toggle('done', ok);
}

// People to allow in the script: default list plus every recurring-meeting list.
function allAllowed() {
  return parseAddresses([$('shareList').value, ...parseGroups($('shareGroups').value).map((g) => g.list.join(','))].join(','));
}
function renderAllow() {
  const l = allowListLines(allAllowed(), { domains: $('shareDomains').checked });
  $('allowLines').textContent = `const ALLOWED = ${l.allowed};\nconst ALLOWED_DOMAINS = ${l.domains};`;
}
['shareList', 'shareGroups'].forEach((id) => ($(id).oninput = renderAllow));
$('shareDomains').onchange = renderAllow;
$('copyScriptAllow').onclick = async () => {
  await navigator.clipboard.writeText(scriptWithAllowList(scriptText, allAllowed(), { domains: $('shareDomains').checked }));
  $('copyAllowMsg').textContent = 'Copied. Paste it over your script, save, then deploy a new version.';
  setTimeout(() => ($('copyAllowMsg').textContent = ''), 6000);
};

$('scriptText').textContent = scriptText;
$('copyScript').onclick = async () => {
  await navigator.clipboard.writeText(scriptText);
  $('copyMsg').textContent = 'Copied ✓';
  setTimeout(() => ($('copyMsg').textContent = ''), 1500);
};

$('testMail').onclick = async () => {
  $('mailMsg').textContent = 'Sending…';
  try {
    const s = await save();
    if (!mailReady(s)) throw new Error('Paste the Apps Script web app URL (it ends in /exec) first.');
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

(async () => {
  const s = await getSettings();
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
  }
  $('shareAuto').checked = s.shareMode === 'auto';
  loaded = read();
  showProviderFields();
  renderAllow();
  micStatus();
  updateGuide();
  renderUsage();
  renderLearned();
  showTab(location.hash.slice(1) || 'start');
})();

// Settings changed somewhere else (a minutes tab, the popup): show the new values in every field this page
// has not touched, so the page is never a stale picture of the real settings.
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.settings) return;
  const fresh = await getSettings();
  for (const k of FIELDS) {
    const el = $(k);
    if (!el || !same(read()[k], loaded[k])) continue; // the user is editing this one
    if (el.type === 'checkbox') el.checked = !!fresh[k];
    else el.value = fresh[k];
    loaded[k] = fresh[k];
  }
  $('shareAuto').checked = fresh.shareMode === 'auto';
  loaded.shareMode = fresh.shareMode;
});
