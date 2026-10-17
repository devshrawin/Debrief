// "Check my setup": one list of what is ready, what is not, and why, to read or paste when something fails.
// Nothing here prints a key, and nothing is sent anywhere except one harmless GET to your own mail relay.
import { getSettings, getVoices, listMeetings, getBlockedVoices } from './store.js';
import { mailReady } from './mailer.js';
import { summarize, parseLimits } from './usage.js';

const OK = '✓';
const WARN = '!';
const BAD = '✗';

export async function runCheckup() {
  const rows = [];
  // `go` names the settings page that fixes a row; the page shows it as a button next to the row.
  const add = (level, title, detail = '', go = '', fixText = '') => rows.push({ level, title, detail, go, fixText });
  const s = await getSettings();

  // keys and quota
  if (s.sttProvider === 'gemini' || s.llmProvider === 'gemini') {
    add(s.geminiKey ? OK : BAD, 'Gemini key', s.geminiKey ? (s.geminiKey2 ? 'main and backup key are set' : 'a key is set (no backup key)') : 'missing: add it on the Get started page', 'start', 'Add key');
    try {
      const { usage, learnedLimits = {}, modelCooldown = {} } = await chrome.storage.local.get(['usage', 'learnedLimits', 'modelCooldown']);
      const limits = { ...learnedLimits, ...parseLimits(s.usageLimits) };
      const today = summarize(usage, 1);
      const used = (m) => today.filter((x) => x.model === m).reduce((a, x) => a + x.req, 0);
      for (const m of [s.sttGeminiModel, s.geminiModel].filter(Boolean)) {
        const lim = limits[m];
        if (!lim) add(OK, `Quota today: ${m}`, `${used(m)} requests so far (limit not known yet)`);
        else add(used(m) >= lim ? BAD : used(m) >= lim * 0.8 ? WARN : OK, `Quota today: ${m}`, `${used(m)} of about ${lim} requests used`);
      }
      const cooling = Object.entries(modelCooldown).filter(([, u]) => u > Date.now());
      if (cooling.length) add(WARN, 'Models resting after hitting their limit', cooling.map(([m, u]) => `${m} until ${new Date(u).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`).join(', '));
    } catch {}
  }

  // microphone
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    add(p.state === 'granted' ? OK : s.captureMic === false ? OK : WARN, 'Microphone permission', p.state === 'granted' ? 'allowed' : `${p.state}: only other people will be recorded until you press "Allow microphone" on the General page`, 'general', 'Allow microphone');
  } catch {}
  add(s.followMeetMute !== false ? OK : WARN, 'Mic follows the call\'s mute button', s.followMeetMute !== false ? 'on' : 'off: your mic is recorded even when you are muted in the call', 'general', 'Turn it on');

  // names and captions
  add(OK, 'Speaker names from Meet captions', { read: 'used when captions are on', auto: 'Debrief turns captions on while recording', off: 'off' }[s.meetCaptions] || s.meetCaptions);

  // email relay
  if (!s.emailWebhook) add(WARN, 'Email relay', 'not set up (optional)', 'email', 'Set up email');
  else if (!mailReady(s)) add(BAD, 'Email relay', 'the URL does not look like an Apps Script web app URL ending in /exec', 'email', 'Fix email');
  else {
    try {
      const res = await fetch(s.emailWebhook, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const j = await res.json();
      if (j?.ok) add(Number(j.version) >= 8 ? OK : WARN, 'Email relay', `reachable, script version ${j.version}${Number(j.version) >= 8 ? '' : '. Version 8 closes a first-use window: copy the script again from Settings > Email and deploy a new version'}`);
      else add(BAD, 'Email relay', 'answered, but not as the Debrief script (is it set to "Anyone"?)', 'email', 'Fix email');
    } catch (e) {
      add(BAD, 'Email relay', `could not be reached (${e.message}). Check the deployment is set to "Anyone"`, 'email', 'Fix email');
    }
  }

  // voices
  const voices = await getVoices();
  const blocked = await getBlockedVoices();
  add(OK, 'Voice recognition', `${s.voiceOn ? 'naming is on' : 'naming is off'}, ${s.voiceLearn ? 'learning is on' : 'learning is off'}; ${voices.filter((v) => !v.auto).length} recorded, ${voices.filter((v) => v.auto && v.ready).length} learned and in use, ${voices.filter((v) => v.auto && !v.ready).length} still learning${blocked.length ? `, ${blocked.length} blocked` : ''}`);
  try {
    const r = await fetch(chrome.runtime.getURL('models/wespeaker_resnet34_lm.onnx'), { method: 'HEAD' });
    add(r.ok ? OK : BAD, 'Speaker model file', r.ok ? 'present in the extension' : 'missing from the extension folder');
  } catch {
    add(BAD, 'Speaker model file', 'could not be read');
  }

  // the last meeting
  try {
    const m = (await listMeetings()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
    if (m) {
      const dbg = m.debug || [];
      const muteLines = dbg.filter((x) => /^Meet mic/.test(x));
      const silent = dbg.find((x) => /^mic: the raw microphone/.test(x));
      add(OK, `Last meeting: ${m.title || m.id}`, `${(m.segments || []).length} transcript pieces, ${(m.errors || []).length} errors, ${Object.keys(m.presence || {}).length} people seen, ${(m.voiceSegs || []).length} voice pieces, ${(m.captions || []).length} caption lines`);
      add(muteLines.length ? OK : WARN, 'Last meeting: the call\'s mute button', muteLines.length ? `${muteLines.length} changes seen; last: ${muteLines.at(-1)}` : 'no mute changes were seen (either you never muted, or the mute button was not found on the page)');
      if (silent) add(BAD, 'Last meeting: microphone', 'it delivered only silence: check the microphone chosen in General and Windows privacy settings', 'general', 'Open General');
      add(m.invited?.length ? OK : WARN, 'Last meeting: calendar invite', m.invited?.length ? `${m.invited.length} invitees found${m.invitedHow ? ` (by ${m.invitedHow})` : ''}` : m.invitedError ? `lookup failed: ${String(m.invitedError).slice(0, 100)}` : m.invitedNotFound ? 'no calendar event matched the Meet link or title' : 'not looked up yet');
    }
  } catch {}
  return rows;
}

export const checkupText = (rows) => rows.map((r) => `${r.level} ${r.title}${r.detail ? `: ${r.detail}` : ''}`).join('\n');
