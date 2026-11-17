// Backup and restore of everything Debrief keeps in chrome.storage.local, as one JSON file. Logic only; the page that
// offers it is separate. A backup file is treated as untrusted data: it is checked for shape, size and types, nothing in
// it is ever run, and unknown parts are ignored.
//
// Audio is not part of a backup: pieces that failed to transcribe and kept voice clips are in IndexedDB on this computer.

import { DEFAULTS, SCHEMA, ensureMigrated, migrateSettings, migrateSettings3, deleteMeeting, getState } from './store.js';
import { LISTS, CAPS, plain, getMeeting, listMeetings, listMeetingMetas, saveMeeting } from './meetingstore.js';
import { isActive } from './jobstate.js';
import { validWebhook } from './webhook.js';

export const BACKUP_VERSION = 1;
// Settings that unlock something: API keys, the relay's secret and the addresses that act as passwords (a webhook URL
// carries its own token). Left out of a backup unless the person asks for them.
export const SECRET_SETTINGS = ['geminiKey', 'geminiBackups', 'sarvamKey', 'deepgramKey', 'anthropicKey', 'oaKey', 'sttKey', 'emailSecret', 'emailWebhook', 'webhookUrl'];
// Settings that decide WHERE meeting data goes, or WHAT is posted or shared on the person's behalf. A backup file can
// come from anyone, so these are never taken from it unless the person ticks each one (importAll's acceptRouting).
// Model names of services with a fixed address (Gemini, Sarvam, Deepgram, Claude) are left out: they change no destination.
export const ROUTING_LABELS = {
  sttProvider: 'Speech-to-text service',
  sttBase: 'Speech-to-text server address',
  sttModel: 'Speech-to-text model on that server',
  llmProvider: 'Service that writes the minutes',
  oaBase: 'Minutes model server address',
  oaModel: 'Minutes model on that server',
  webhookUrl: 'Webhook address',
  emailWebhook: 'Email relay address',
  emailTo: 'Address the minutes email goes to',
  emailAuto: 'Email the minutes as soon as they are written',
  emailTranscript: 'Attach the transcript to the email',
  shareMode: 'Who gets the minutes automatically',
  shareList: 'People the minutes are shared with',
  shareGroups: 'People per recurring meeting',
  shareHow: 'How those people are addressed (To, Cc or Bcc)',
  shareDomains: 'Let the relay send to whole company domains',
  shareExternalGuard: 'Hold back automatic sharing with outsiders',
  myOrgDomains: "Your organisation's email domains",
  calendarLookup: 'Ask your calendar who was invited',
  consentNotice: 'Post a notice in the meeting chat',
  consentText: 'Notice posted in the meeting chat',
  screenNotes: 'Send pictures of the shared screen to the minutes service',
  voiceModelUrl: 'Speaker model download address',
};
export const ROUTING_SETTINGS = Object.keys(ROUTING_LABELS);
// A server address and the key that is sent to it: a new address from a file never gets the key that is here.
const KEY_FOR = { sttBase: 'sttKey', oaBase: 'oaKey', emailWebhook: 'emailSecret' };
const URL_SETTINGS = ['sttBase', 'oaBase', 'webhookUrl', 'emailWebhook', 'voiceModelUrl'];
export const UI_PREFS = ['uiTheme', 'uiMotion', 'uiSolid', 'uiEffects', 'uiPanel'];
export const LIMITS = { meetings: 5000, string: 20 * 1024 * 1024, voices: 1000 };
const ID = /^m\d{10,16}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
// An address taken from a file: https, or http only for a program on this computer; no user name or password.
function safeUrl(v) {
  try {
    const u = new URL(String(v).trim());
    if (u.username || u.password) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.hostname));
  } catch {
    return false;
  }
}
const originOf = (v) => {
  try {
    return `${new URL(String(v).trim()).origin}/*`;
  } catch {
    return null;
  }
};

export async function exportAll({ includeKeys = false } = {}) {
  await ensureMigrated();
  const r = await chrome.storage.local.get(['settings', 'schema', 'voices', 'voiceBlock', 'emailNames', 'learned', 'usage', 'learnedLimits', ...UI_PREFS]);
  const settings = { ...(r.settings || {}) };
  if (!includeKeys) for (const k of SECRET_SETTINGS) delete settings[k];
  const uiPrefs = Object.fromEntries(UI_PREFS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  return plain({
    app: 'debrief',
    version: BACKUP_VERSION,
    schema: r.schema ?? SCHEMA,
    exportedAt: Date.now(),
    settings,
    meetings: await listMeetings(),
    voices: r.voices || [],
    voiceBlock: r.voiceBlock || [],
    emailNames: r.emailNames || {},
    learned: r.learned || {},
    usage: r.usage || {},
    learnedLimits: r.learnedLimits || {},
    uiPrefs,
    notes: [
      'Audio is not included: pieces of audio that failed to transcribe and kept voice clips stay on this computer only.',
      includeKeys ? 'This file contains your API keys and the email relay secret. Keep it private.' : 'API keys, the email relay secret and webhook addresses are not included.',
    ],
  });
}

// One meeting, for sharing or keeping. The voice fingerprints are left out unless asked for.
export async function exportMeeting(id, { voiceSegs = false } = {}) {
  const m = await getMeeting(id);
  if (!m) return null;
  const meeting = plain(m);
  if (!voiceSegs) delete meeting.voiceSegs;
  return { app: 'debrief', version: BACKUP_VERSION, exportedAt: Date.now(), meeting };
}

// Throws on any string longer than the limit, anywhere in the file (a huge field could fill the storage or freeze a page).
function checkSizes(data) {
  const stack = [data];
  const seen = new Set();
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.length > LIMITS.string) throw new Error('The backup has a field that is far too large.');
    } else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push(x);
    }
  }
}

// A setting is taken only if Debrief knows it and its type matches the default's.
function cleanSettings(raw, schema) {
  let s = { ...raw };
  // the same steps ensureMigrated runs on a stored copy, from the schema the file was written with
  if (!(schema >= 2)) s = migrateSettings(s);
  if (!(schema >= 3)) s = migrateSettings3(s);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!(k in DEFAULTS)) continue;
    const d = DEFAULTS[k];
    if (Array.isArray(d)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string' || isObj(x))) out[k] = v;
    } else if (typeof v === typeof d) out[k] = v;
  }
  return out;
}

function cleanMeeting(raw, warnings) {
  const m = {};
  for (const [k, v] of Object.entries(raw)) if (!['parts', 'counts', '__loaded'].includes(k)) m[k] = v;
  for (const l of LISTS) {
    if (!(l in m)) continue;
    if (!Array.isArray(m[l])) {
      warnings.push(`Meeting ${String(raw.id).slice(0, 40)}: ${l} was not a list and was left out.`);
      delete m[l];
      continue;
    }
    m[l] = m[l].filter((x) => typeof x === 'string' || isObj(x));
    if (l === 'silences') m[l] = m[l].slice(0, CAPS.silences);
    else if (CAPS[l]) m[l] = m[l].slice(-CAPS[l]);
  }
  m.segments ||= [];
  m.errors ||= [];
  if (typeof m.title !== 'string') m.title = 'Meeting';
  if (!Number.isFinite(m.startedAt)) m.startedAt = 0;
  // a job that was running when the backup was made has no runner here: never resume it (and never send its email)
  if (isActive(m)) m.job = { ...(isObj(m.job) ? m.job : {}), state: m.mom ? 'done' : 'failed', error: m.mom ? null : 'Imported from a backup before the minutes were written.', beat: 0 };
  delete m.emailSending;
  return m;
}

// Everything a file is checked for before anything is written. Throws with a plain message when the file is refused.
function checkFile(data, mode) {
  if (!isObj(data) || data.app !== 'debrief') throw new Error('This is not a Debrief backup.');
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Debrief.');
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Unknown import mode.');
  if (data.meetings !== undefined && !Array.isArray(data.meetings)) throw new Error('The meetings in this backup are damaged.');
  if ((data.meetings || []).length > LIMITS.meetings) throw new Error(`This backup has more than ${LIMITS.meetings} meetings.`);
  checkSizes(data);
}

const SHARE_MODES = { review: 'only me, until I press Share', auto: 'me and the people listed' };
// A setting as the person reads it: on/off, the share mode in words, an address as its host only when it carries a token.
function shown(key, v) {
  if (isEmpty(v)) return '(not set)';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (key === 'shareMode' && SHARE_MODES[v]) return SHARE_MODES[v];
  if (SECRET_SETTINGS.includes(key)) {
    try {
      return `${new URL(String(v)).origin}/… (rest hidden)`;
    } catch {
      return '(set, hidden)';
    }
  }
  const s = String(Array.isArray(v) ? v.join(', ') : v).replace(/\s+/g, ' ').trim();
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

// What a file would change, for the page to ask about before anything is written. Reads only; never writes.
// routing: the settings that decide where data goes and that differ from what is set here, in plain words.
export async function previewImport(data) {
  try {
    checkFile(data, 'merge');
  } catch (e) {
    return { ok: false, error: e.message, meetings: 0, voices: 0, hasSettings: false, routing: [], warnings: [] };
  }
  const warnings = [];
  const settings = isObj(data.settings) ? cleanSettings(data.settings, Number(data.schema) || 0) : null;
  if (data.settings !== undefined && !settings) warnings.push('The settings in this backup are damaged and will be left out.');
  const { settings: stored } = await chrome.storage.local.get('settings');
  const here = { ...DEFAULTS, ...(stored || {}) };
  const routing = [];
  for (const key of ROUTING_SETTINGS) {
    if (!settings || !(key in settings)) continue;
    const to = settings[key];
    if (same(to, here[key]) || (isEmpty(to) && !isEmpty(here[key]))) continue; // no change, or an empty value (never written over a set one)
    if (URL_SETTINGS.includes(key) && !isEmpty(to) && !(key === 'webhookUrl' ? validWebhook(to) : safeUrl(to))) {
      warnings.push(`${ROUTING_LABELS[key]} in this file is not a safe address and will be left out.`);
      continue;
    }
    routing.push({ key, label: ROUTING_LABELS[key], from: shown(key, here[key]), to: shown(key, to), origin: URL_SETTINGS.includes(key) && !isEmpty(to) ? originOf(to) : null });
  }
  return {
    ok: true,
    meetings: Array.isArray(data.meetings) ? data.meetings.length : 0,
    voices: Array.isArray(data.voices) ? data.voices.length : 0,
    hasSettings: !!settings,
    routing,
    warnings,
  };
}

// The settings to write: what is here, with the file's values on top where the rules allow.
//  - a routing setting only when its key is in `accept` (any mode), and only a safe address;
//  - merge: any other setting only where nothing (or the default) is set here; replace: any other setting from the file;
//  - never an empty value over a set one, never a key or the relay secret over one that is set here;
//  - a server address that changes takes the file's key for it, or none: the key here is never sent to a new server.
function mergeSettings(here, settings, { mode, accept, warnings }) {
  const out = { ...here };
  const eff = (k) => (k in here ? here[k] : DEFAULTS[k]);
  const accepted = [];
  for (const [k, v] of Object.entries(settings)) {
    if (k in KEY_FOR_REVERSE) continue; // a key that goes with a server address is decided with that address below
    if (isEmpty(v) && !isEmpty(here[k])) continue;
    if (ROUTING_SETTINGS.includes(k)) {
      if (!accept.has(k) || same(v, eff(k))) continue;
      if (URL_SETTINGS.includes(k) && !isEmpty(v) && !(k === 'webhookUrl' ? validWebhook(v) : safeUrl(v))) {
        warnings.push(`${ROUTING_LABELS[k]} in the backup is not a safe address and was left out.`);
        continue;
      }
      out[k] = v;
      accepted.push(k);
      continue;
    }
    if (SECRET_SETTINGS.includes(k) && !isEmpty(here[k])) continue; // keys set here win, in both modes
    if (mode === 'merge' && k in here && !same(here[k], DEFAULTS[k])) continue; // what is set here wins in a merge
    out[k] = v;
  }
  for (const [base, key] of Object.entries(KEY_FOR)) {
    const fileKey = settings[key];
    if (accepted.includes(base)) {
      // the address changed: the file's own key for it, else none
      out[key] = isEmpty(fileKey) ? '' : fileKey;
      if (isEmpty(fileKey) && !isEmpty(here[key])) warnings.push(KEY_CLEARED[base]);
    } else if (!isEmpty(fileKey) && isEmpty(here[key])) out[key] = fileKey; // nothing set here: the file's key for the address that stays
  }
  return { settings: out, accepted };
}
const KEY_FOR_REVERSE = Object.fromEntries(Object.entries(KEY_FOR).map(([b, k]) => [k, b]));
const KEY_CLEARED = {
  sttBase: 'The speech-to-text server address changed, so your speech-to-text key was removed (it is never sent to a new server). Enter the key for the new server in Settings.',
  oaBase: 'The minutes model server address changed, so its key was removed (it is never sent to a new server). Enter the key for the new server in Settings.',
  emailWebhook: 'The email relay address changed, so the relay secret was removed. A new one is made the next time an email is sent; update the relay script with it.',
};

async function recordingNow() {
  try {
    const st = await getState();
    return st?.recording ? st.meetingId || null : null;
  } catch {
    return null; // no session storage here (a test): nothing is being recorded
  }
}

// Restores a backup. Nothing is written until the whole file has been checked.
// mode 'merge' (default) keeps everything here and adds what is new: a meeting whose id is already here is skipped, and a
// setting that is already set here is kept. mode 'replace' puts the file's meetings and settings in place of the ones
// here. In both modes the settings that decide where data goes (ROUTING_SETTINGS) are only taken when listed in
// acceptRouting, and the meeting being recorded right now is never deleted.
// The list of meetings is written before each record, so an import cut off half way never leaves a record nobody can see.
export async function importAll(data, { mode = 'merge', acceptRouting = [] } = {}) {
  checkFile(data, mode);
  const warnings = [];
  const accept = new Set((Array.isArray(acceptRouting) ? acceptRouting : []).filter((k) => ROUTING_SETTINGS.includes(k)));

  // ---- check everything first ----
  const before = await listMeetingMetas({ counts: [] });
  const live = await recordingNow();
  const existing = mode === 'merge' ? before : before.filter((m) => m.id === live);
  const taken = new Set(existing.map((m) => m.id));
  const incoming = [];
  let skipped = 0;
  let next = Date.now();
  for (const raw of data.meetings || []) {
    if (!isObj(raw)) {
      warnings.push('A meeting that was not a record was left out.');
      continue;
    }
    const m = cleanMeeting(raw, warnings);
    if (typeof m.id !== 'string' || !ID.test(m.id)) {
      while (taken.has(`m${next}`)) next++;
      warnings.push(`A meeting with the id ${JSON.stringify(String(m.id ?? '')).slice(0, 40)} was given a new id.`);
      m.id = `m${next++}`;
    } else if (taken.has(m.id)) {
      skipped++;
      if (m.id === live && mode === 'replace') warnings.push('A meeting in the backup has the id of the meeting being recorded now, so it was left out.');
      continue;
    }
    taken.add(m.id);
    incoming.push(m);
  }
  const settings = isObj(data.settings) ? cleanSettings(data.settings, Number(data.schema) || 0) : null;
  if (data.settings !== undefined && !settings) warnings.push('The settings in this backup were damaged and were left out.');
  const voices = Array.isArray(data.voices) ? data.voices.filter((v) => isObj(v) && (typeof v.id === 'string' || typeof v.name === 'string')).slice(0, LIMITS.voices) : null;
  const voiceBlock = Array.isArray(data.voiceBlock) ? data.voiceBlock.filter(isObj) : null;
  const emailNames = isObj(data.emailNames) ? Object.fromEntries(Object.entries(data.emailNames).filter(([k, v]) => typeof v === 'string' && k.length < 320)) : null;
  const learned = isObj(data.learned) ? { names: isObj(data.learned.names) ? Object.fromEntries(Object.entries(data.learned.names).filter(([, v]) => Number.isFinite(v))) : {}, pending: Array.isArray(data.learned.pending) ? data.learned.pending.filter(isObj) : [], rejected: Array.isArray(data.learned.rejected) ? data.learned.rejected.filter((x) => typeof x === 'string') : [] } : null;
  const uiPrefs = isObj(data.uiPrefs) ? Object.fromEntries(UI_PREFS.filter((k) => ['string', 'boolean'].includes(typeof data.uiPrefs[k])).map((k) => [k, data.uiPrefs[k]])) : {};

  // ---- write ----
  await ensureMigrated();
  const ids = async () => (await chrome.storage.local.get('meetingIds')).meetingIds || [];
  const incomingIds = new Set(incoming.map((m) => m.id));
  // replace: an old meeting with the id of a new one goes first (its records are rewritten); the others only after the new ones are saved
  const old = mode === 'replace' ? before.filter((m) => m.id !== live) : [];
  for (const m of old) if (incomingIds.has(m.id)) await deleteMeeting(m.id);
  // every new id is listed before its record is written: a record that is not listed would be invisible
  const listed = await ids();
  await chrome.storage.local.set({ meetingIds: [...incoming.map((m) => m.id).filter((id) => !listed.includes(id)), ...listed] });
  for (const m of incoming) await saveMeeting(m); // a new record: every list is written
  for (const m of old) if (!incomingIds.has(m.id)) await deleteMeeting(m.id);
  if (mode === 'replace' && live && before.some((m) => m.id === live)) warnings.push('The meeting being recorded now was kept.');
  // the list of meetings, newest first (the service worker looks at the newest ones for unfinished jobs); an id that was
  // added while this ran (a recording that started) stays, first
  const when = new Map([...before, ...incoming].map((m) => [m.id, m.startedAt || 0]));
  const now = await ids();
  const unknown = now.filter((id) => !when.has(id));
  const known = [...new Set(now.filter((id) => when.has(id)))].sort((a, b) => when.get(b) - when.get(a));
  await chrome.storage.local.set({ meetingIds: [...unknown, ...known] });

  const cur = await chrome.storage.local.get(['settings', 'voices', 'voiceBlock', 'emailNames', 'learned', 'usage', 'learnedLimits', ...UI_PREFS]);
  const out = {};
  let settingsApplied = false;
  let routingApplied = [];
  if (settings) {
    const r = mergeSettings({ ...(cur.settings || {}) }, settings, { mode, accept, warnings });
    out.settings = r.settings;
    routingApplied = r.accepted;
    settingsApplied = true;
  }
  let voiceCount = 0;
  if (voices) {
    const have = mode === 'merge' ? cur.voices || [] : [];
    const vids = new Set(have.map((v) => v.id).filter(Boolean));
    const add = voices.filter((v) => !(v.id && vids.has(v.id)));
    voiceCount = add.length;
    out.voices = [...have, ...add];
  }
  if (voiceBlock) out.voiceBlock = [...(mode === 'merge' ? cur.voiceBlock || [] : []), ...voiceBlock].slice(-100);
  if (emailNames) out.emailNames = mode === 'merge' ? { ...emailNames, ...(cur.emailNames || {}) } : emailNames; // a name known here is never flipped
  if (learned) {
    const h = mode === 'merge' ? cur.learned || {} : {};
    const pendingIds = new Set((h.pending || []).map((p) => p.id));
    out.learned = { ...h, names: { ...learned.names, ...(h.names || {}) }, pending: [...(h.pending || []), ...learned.pending.filter((p) => !pendingIds.has(p.id))], rejected: [...new Set([...(h.rejected || []), ...learned.rejected])] };
  }
  if (isObj(data.usage) && (mode === 'replace' || !cur.usage)) out.usage = data.usage;
  if (isObj(data.learnedLimits) && (mode === 'replace' || !cur.learnedLimits)) out.learnedLimits = Object.fromEntries(Object.entries(data.learnedLimits).filter(([, v]) => Number.isFinite(v)));
  for (const [k, v] of Object.entries(uiPrefs)) if (mode === 'replace' || cur[k] === undefined) out[k] = v;
  if (Object.keys(out).length) await chrome.storage.local.set(plain(out));
  // the addresses the page should ask Chrome's permission for (a server or webhook taken from the file)
  const origins = [...new Set(routingApplied.filter((k) => ['sttBase', 'oaBase', 'webhookUrl'].includes(k)).map((k) => originOf(out.settings[k])).filter(Boolean))];
  return { meetings: { added: incoming.length, skipped }, settingsApplied, routingApplied, origins, voices: voiceCount, warnings };
}
