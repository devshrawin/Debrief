import { DEFAULTS, getSettings, saveSettings } from './store.js';
import { generate } from './llm.js';
import { sendMail, mailReady } from './mailer.js';
import scriptText from '../apps-script/Code.gs';

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);

function read() {
  const s = {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    s[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return s;
}

function showProviderFields() {
  document.querySelectorAll('[data-stt]').forEach((el) => el.classList.toggle('hidden', el.dataset.stt !== $('sttProvider').value));
  document.querySelectorAll('[data-llm]').forEach((el) => el.classList.toggle('hidden', el.dataset.llm !== $('llmProvider').value));
  $('geminiSection').classList.toggle('hidden', $('sttProvider').value !== 'gemini' && $('llmProvider').value !== 'gemini');
}

// Custom base URLs need a host permission so the extension can call them without CORS trouble.
async function requestOrigins(s) {
  const urls = [];
  if (s.sttProvider === 'openai') urls.push(s.sttBase);
  if (s.llmProvider === 'openai') urls.push(s.oaBase);
  const origins = [];
  for (const u of urls) {
    try {
      origins.push(`${new URL(u).origin}/*`);
    } catch {
      throw new Error(`Invalid base URL: ${u}`);
    }
  }
  if (!origins.length || (await chrome.permissions.contains({ origins }))) return;
  if (!(await chrome.permissions.request({ origins }))) throw new Error('Permission for the custom endpoint was denied.');
}

async function save() {
  const s = { ...(await getSettings()), ...read() };
  await requestOrigins(s);
  await saveSettings(s);
  return s;
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
  showProviderFields();
  micStatus();
  updateGuide();
})();
