// Backup and restore of everything Debrief keeps in chrome.storage.local, as one JSON file. Logic only; the page that
// offers it is separate. A backup file is treated as untrusted data: it is checked for shape, size and types, nothing in
// it is ever run, and unknown parts are ignored.
//
// Audio is not part of a backup: pieces that failed to transcribe and kept voice clips are in IndexedDB on this computer.

import { DEFAULTS, SCHEMA, ensureMigrated, migrateSettings, migrateSettings3, deleteMeeting } from './store.js';
import { LISTS, CAPS, plain, getMeeting, listMeetings, listMeetingMetas, saveMeeting } from './meetingstore.js';
import { isActive } from './jobstate.js';

export const BACKUP_VERSION = 1;
// Settings that unlock something: API keys, the relay's secret and the addresses that act as passwords (a webhook URL
// carries its own token). Left out of a backup unless the person asks for them.
export const SECRET_SETTINGS = ['geminiKey', 'geminiBackups', 'sarvamKey', 'deepgramKey', 'anthropicKey', 'oaKey', 'sttKey', 'emailSecret', 'emailWebhook', 'webhookUrl'];
export const UI_PREFS = ['uiTheme', 'uiMotion', 'uiSolid', 'uiEffects', 'uiPanel'];
export const LIMITS = { meetings: 5000, string: 20 * 1024 * 1024, voices: 1000 };
const ID = /^m\d{10,16}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

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

// Restores a backup. mode 'merge' (default) keeps everything here and adds what is new: a meeting whose id is already here
// is skipped, and keys already set here are kept. mode 'replace' deletes the meetings here first. Nothing is written until
// the whole file has been checked. Never writes an empty value over a setting that has one.
export async function importAll(data, { mode = 'merge' } = {}) {
  if (!isObj(data) || data.app !== 'debrief') throw new Error('This is not a Debrief backup.');
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Debrief.');
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Unknown import mode.');
  if (data.meetings !== undefined && !Array.isArray(data.meetings)) throw new Error('The meetings in this backup are damaged.');
  if ((data.meetings || []).length > LIMITS.meetings) throw new Error(`This backup has more than ${LIMITS.meetings} meetings.`);
  checkSizes(data);
  const warnings = [];

  // ---- check everything first ----
  const existing = mode === 'merge' ? await listMeetingMetas({ counts: [] }) : [];
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
  if (mode === 'replace') for (const m of await listMeetingMetas({ counts: [] })) await deleteMeeting(m.id);
  for (const m of incoming) await saveMeeting(m); // a new record: every list is written
  // the list of meetings, newest first (the service worker looks at the newest ones for unfinished jobs)
  const rows = mode === 'replace' ? incoming : [...existing, ...incoming];
  await chrome.storage.local.set({ meetingIds: rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).map((m) => m.id) });

  const cur = await chrome.storage.local.get(['settings', 'voices', 'voiceBlock', 'emailNames', 'learned', 'usage', 'learnedLimits', ...UI_PREFS]);
  const out = {};
  let settingsApplied = false;
  if (settings) {
    const here = { ...(cur.settings || {}) };
    for (const [k, v] of Object.entries(settings)) {
      if (isEmpty(v) && !isEmpty(here[k])) continue; // never an empty value over one that is set
      if (mode === 'merge' && SECRET_SETTINGS.includes(k) && !isEmpty(here[k])) continue; // keys set here win
      here[k] = v;
    }
    out.settings = here;
    settingsApplied = true;
  }
  let voiceCount = 0;
  if (voices) {
    const have = mode === 'merge' ? cur.voices || [] : [];
    const ids = new Set(have.map((v) => v.id).filter(Boolean));
    const add = voices.filter((v) => !(v.id && ids.has(v.id)));
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
  return { meetings: { added: incoming.length, skipped }, settingsApplied, voices: voiceCount, warnings };
}
