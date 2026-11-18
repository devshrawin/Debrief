import { clearAllAudio, deletePieces, deleteUnnamedClips } from './voice/samples.js';
import { cleanTerms } from './sttclean.js';
import { deleteAllPending } from './audiostore.js';
import { deleteAudio } from './audiokeep.js';
import { plain, editMeetingIds, removeMeetingRecords, stripVoicesFromAll } from './meetingstore.js';
// Settings + meeting records in chrome.storage.local; recorder state in chrome.storage.session.

export const DEFAULTS = {
  noticeAck: false, // the person has confirmed once that they will tell others on the call they are recording
  myName: '',
  captureMic: true,
  meetingLanguages: [], // languages to expect (codes from languages.js); empty = automatic
  pillOnPage: false, // also show the pill inside the Meet page
  hideRecIcon: false, // no glowing toolbar icon during a call and no REC badge while recording ("!" still shows)
  quotaWarnings: true, // warn in the popup when a model is near its daily limit (off for a paid key)
  emailSecret: '', // made up by Debrief, never typed; the relay script locks itself to it on first use
  emailWebhook: '', // Google Apps Script web app URL (apps-script/Code.gs)
  emailTo: '', // optional; the script only allows you and its ALLOWED list
  emailAuto: true, // email the MOM as soon as it is written
  emailPdf: true, // attach the MOM as PDF
  emailWord: false, // attach the MOM as Word (.doc)
  emailMd: false, // attach the MOM as Markdown
  emailTranscript: false, // attach the transcript as .txt
  autoStop: true, // stop recording by itself when the meeting is over
  autoStopQuietMin: 10, // ...or after this many silent minutes (0 = never)
  usageLimits: '', // one "model=daily requests" per line; learned from 429s too
  usdInr: 88, // rupees per US dollar, to show the 'cost if paid' estimate in rupees
  usagePrices: '', // one "model=USD per 1M input,USD per 1M output" per line
  dictAutoAlias: false, // accept clear-cut learned fixes (3+ sightings) without asking
  dictionary: '', // names and terms, one per line: Right | misheard, as, this
  minutesMode: 'thorough', // thorough = extract, write, then check; quick = one pass
  sttGeminiChunk: 'standard', // short = about 40 s (the live transcript keeps up; more requests); standard = 100-150 s chunks; long = about 240 s (fewer requests per meeting)
  minutesFormat: 'standard', // template = the organisation template (header block, attendee tables; Print/PDF, Word, email); standard = Debrief's own layout
  orgName: '', // organisation template: name, confidentiality line (page footer) and accent colour; empty = generic. Settings has a "Use Amnex preset" button
  orgConfidential: '',
  orgAccent: '',
  myOrgDomains: '', // email domains of the System Integrator side (comma separated); empty = the domain of "Send to", else one list
  peopleDirectory: '', // one per line: Name | Honorific | Department | Designation | Organisation [| Chair]
  shareList: '', // default people to share the minutes with
  meetingTypes: [], // kinds of recurring meeting with extra minutes sections: [{ id, name, match, code, updates, columns, extra }] (src/meetingtypes.js)
  shareGroups: '', // per recurring meeting: "title words | a@x.com, b@y.com"
  shareMode: 'review', // review = only I get it until I press Share; auto = send to them too
  shareHow: 'to', // to | cc | bcc
  shareDomains: false, // script helper: allow whole company domains instead of single addresses
  calendarLookup: true, // ask the relay who was invited (needs the calendar permission)
  meetCaptions: 'read', // read speaker names from Meet's captions: off | read (when you have captions on) | auto (turn them on)
  otherSites: true, // use the page features (amber dot, mute follow, auto-stop) on Zoom, Teams, Webex and other meeting apps
  voiceOn: false, // recognise who is speaking, using voices enrolled in Settings
  voiceSamples: true, // keep a short audio clip of each unnamed voice so it can be played to name it (off: no audio is kept)
  voiceLearn: false, // learn voices on its own from Meet's captions (needs captions read) and fingerprints of the meeting
  followMeetMute: true, // ignore my mic while Meet's own mic button is muted
  momLanguage: 'English',

  // ---- 1.4.0 ----
  minutesEngine: 'structured', // structured = one JSON call (decisions, actions, risks, questions) rendered by code, with the classic pipeline as the fallback; classic = extract, write, check
  actionCarry: true, // open action items of the previous meeting in the same series are reviewed in the next one
  webhookUrl: '', // optional: POST the structured minutes (JSON) here when they are written
  shareExternalGuard: true, // never auto-share with addresses outside my organisation's domains; ask first
  keepAudio: false, // keep the compressed recording on this computer so a line can be played back and re-transcribed
  keepAudioDays: 14, // ...for this many days (0 = until the meeting is deleted)
  screenNotes: false, // describe what is shown on the shared screen (costs model requests)
  screenNotesEverySec: 30, // at most one screen description per this many seconds, and only when the picture changed
  consentNotice: false, // post a notice in the meeting chat when recording starts (Google Meet)
  consentText: 'This meeting is being transcribed by Debrief to write the minutes.',
  recordNudge: true, // remind me to record when a call matches one of my meeting types
  nudgeSkipOneOnOne: true, // ...but not when only two people are in the call
  askExpand: true, // let the model rewrite a question into search words in every script before searching all meetings
  voiceModelUrl: '', // where to download the speaker model from when it is not bundled (lite build)

  geminiKey: '', // shared by Gemini transcription and the Gemini MOM writer
  geminiBackups: [], // backup keys (ideally from other Google Cloud projects), tried in order after the main key
  sttProvider: 'gemini', // gemini | sarvam | deepgram | openai
  sttGeminiModel: 'gemini-3.5-transcribe',
  sarvamKey: '',
  sarvamModel: 'saaras:v4',
  sarvamMode: 'codemix', // codemix | transcribe | translate
  sarvamLanguage: 'unknown',
  deepgramKey: '',
  deepgramModel: 'nova-3',
  sttBase: 'https://api.groq.com/openai/v1',
  sttKey: '',
  sttModel: 'whisper-large-v3',
  sttPrompt: 'Hinglish office meeting. Hindi in Devanagari, English words in English.',

  llmProvider: 'gemini', // gemini | anthropic | openai
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  oaBase: 'https://api.openai.com/v1',
  oaKey: '',
  oaModel: '',
  geminiModel: 'gemini-3.8-flash',
};

// Installs that existed before the organisation template keep what they had: minutes in the template format with the Amnex
// name, footer and colour. A brand-new install starts generic. Each schema step runs once, in whichever context asks first.
export const AMNEX_PRESET = { orgName: 'Amnex Infotechnologies', orgConfidential: 'Amnex Infotechnologies Pvt Ltd | Confidential', orgAccent: '#0c2461', myOrgDomains: 'amnex.com' };
export const SCHEMA = 3;
// The format was first stored as 'amnex'; 'template' is the name now. Old saved values are still read as the template.
export const isTemplateFormat = (f) => f === 'template' || f === 'amnex';
export const normalizeFormat = (f) => (isTemplateFormat(f) ? 'template' : f);
// Same mapping as src/languages.js applies to the old single setting when the list is empty.
const LEGACY_LANGUAGES = { auto: [], hinglish: ['hi', 'en'], malayalam: ['ml', 'en'] };
export function migrateSettings(settings) {
  const next = { ...settings, minutesFormat: settings.minutesFormat ?? 'amnex' };
  for (const [k, v] of Object.entries(AMNEX_PRESET)) if (!next[k]) next[k] = v;
  return next;
}
// Schema 3: 'amnex' becomes 'template'; the old single language setting and the separate second Gemini key are folded
// into the list settings that replaced them.
export function migrateSettings3(settings) {
  const next = { ...settings };
  if (next.minutesFormat === 'amnex') next.minutesFormat = 'template';
  if ('meetingLanguage' in next) {
    if (!(Array.isArray(next.meetingLanguages) && next.meetingLanguages.length)) next.meetingLanguages = [...(LEGACY_LANGUAGES[next.meetingLanguage] || [])];
    delete next.meetingLanguage;
  }
  if ('geminiKey2' in next) {
    const k2 = String(next.geminiKey2 || '').trim();
    if (k2) next.geminiBackups = [k2, ...(next.geminiBackups || []).filter((k) => k && k !== k2)];
    delete next.geminiKey2;
  }
  return next;
}
let migrating = null;
export function ensureMigrated() {
  migrating ||= (async () => {
    const { settings, schema } = await chrome.storage.local.get(['settings', 'schema']);
    if (schema >= SCHEMA) return;
    const legacy = !!settings && Object.keys(settings).length > 0;
    let next = settings;
    if (legacy) {
      if (!(schema >= 2)) next = migrateSettings(next); // steps run in order
      next = migrateSettings3(next);
    }
    await chrome.storage.local.set({ schema: SCHEMA, ...(legacy ? { settings: next } : {}) });
  })().catch(() => {
    migrating = null;
  });
  return migrating;
}

export async function getSettings() {
  await ensureMigrated();
  const { settings, learned, voices } = await chrome.storage.local.get(['settings', 'learned', 'voices']);
  // Names learned from past meetings (not part of what the user typed) are used as spelling hints.
  const learnedNames = cleanTerms(Object.entries(learned?.names || {}).sort((a, b) => a[1] - b[1]).map(([n]) => n)).slice(-80);
  // Enrolled voice fingerprints ride along for matching but are never saved into the settings.
  return { ...DEFAULTS, ...(settings || {}), learnedNames, voices: voices || [] };
}

export async function saveSettings(s) {
  const { learnedNames, voices, ...own } = s;
  await chrome.storage.local.set({ settings: own });
}

export function sttReady(s) {
  if (s.sttProvider === 'gemini') return !!s.geminiKey && !!s.sttGeminiModel;
  if (s.sttProvider === 'sarvam') return !!s.sarvamKey;
  if (s.sttProvider === 'deepgram') return !!s.deepgramKey;
  return !!s.sttBase && !!s.sttModel;
}

export function llmReady(s) {
  if (s.llmProvider === 'anthropic') return !!s.anthropicKey && !!s.anthropicModel;
  if (s.llmProvider === 'gemini') return !!s.geminiKey && !!s.geminiModel;
  return !!s.oaBase && !!s.oaModel;
}

// Meetings live in src/meetingstore.js (META plus chunked lists); these names stay importable from here.
export { LISTS, CAPS, getMeeting, getMeetingMeta, saveMeeting, patchMeeting, updateMeetingMeta, appendMeeting, editMeetingTail, replaceMeetingList, trimMeetingList, listMeetings, listMeetingMetas, addMeetingId, editMeetingIds, stampLoaded, withWireStamps } from './meetingstore.js';

export async function deleteMeeting(id) {
  await editMeetingIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : null));
  await removeMeetingRecords(id);
  // the audio that belonged to it too: waiting voice pieces and chunks that failed to transcribe
  await Promise.allSettled([deletePieces(id), deleteAllPending(id), deleteUnnamedClips(id), deleteAudio(id)]); // and the kept recording, if any
}

// Deleting from a page: the minutes job of this meeting is stopped first (the background runner), so nothing is emailed,
// shared or posted for a meeting that is gone. The job also stops by itself when it finds the meeting missing; this just
// saves its model calls. Quiet where there is no runtime (tests) or no runner.
export async function deleteMeetingAndStop(id) {
  try {
    if (globalThis.chrome?.runtime?.sendMessage) await chrome.runtime.sendMessage({ target: 'bg', type: 'job-abort', id });
  } catch {}
  await deleteMeeting(id);
}

export async function getState() {
  const { rec } = await chrome.storage.session.get('rec');
  return rec || { recording: false };
}

export async function setState(rec) {
  await chrome.storage.session.set({ rec });
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Pulls the human-readable message out of a provider's JSON error body.
export function errorDetail(text) {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    return (typeof e === 'string' ? e : e?.message) || j.err_msg || j.message || j.detail || text;
  } catch {
    return text;
  }
}

// Writes only the given keys into the stored settings. Pages that hold an old copy of the settings
// (a tour, a settings tab, a minutes tab left open) must never save the whole copy back.
export async function setSetting(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  const { learnedNames, voices, ...clean } = patch;
  await chrome.storage.local.set({ settings: { ...(settings || {}), ...clean } });
}

// The relay secret: random, created once, stored with the settings, never shown.
export async function ensureEmailSecret() {
  await ensureMigrated();
  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.emailSecret) return settings.emailSecret;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ settings: { ...(settings || {}), emailSecret: secret } });
  return secret;
}

// ---- enrolled voices: fingerprints only (numbers), never audio ----
export async function getVoices() {
  const { voices } = await chrome.storage.local.get('voices');
  return voices || [];
}

// plain(): typed arrays become ordinary arrays (chrome.storage cannot hold them); it lives with the meeting store.
export { plain };
// findTyped() says where a typed array was, for the debug note.
export function findTyped(v, path = '', seen = new Set()) {
  if (ArrayBuffer.isView(v)) return path || '(root)';
  if (!v || typeof v !== 'object' || seen.has(v)) return '';
  seen.add(v);
  for (const [k, x] of Object.entries(v)) {
    const hit = findTyped(x, `${path}${path ? '.' : ''}${k}`, seen);
    if (hit) return hit;
  }
  return '';
}

export async function saveVoices(list) {
  await chrome.storage.local.set({ voices: plain(list) });
}

// Deletes every enrolled voice, and the voice fingerprints kept inside saved meetings.
export async function forgetAllVoices() {
  // the blocklist holds voice templates and emailNames holds who-is-who: both go with the voices
  await chrome.storage.local.remove(['voices', 'voiceBlock', 'emailNames']);
  await clearAllAudio().catch(() => {});
  return stripVoicesFromAll();
}

// Learned voices the user deleted and asked not to learn again: [{ name, centroid }].
export async function getBlockedVoices() {
  const { voiceBlock } = await chrome.storage.local.get('voiceBlock');
  return voiceBlock || [];
}

export async function saveBlockedVoices(list) {
  await chrome.storage.local.set({ voiceBlock: list.slice(-100) });
}

// Which e-mail address belongs to which name (learned from meetings, or set by hand): { "deep5@amnex.com": "Deep Patel" }.
export async function getEmailNames() {
  const { emailNames } = await chrome.storage.local.get('emailNames');
  return emailNames || {};
}

export async function saveEmailNames(map) {
  await chrome.storage.local.set({ emailNames: map });
}

// Adds links without ever replacing one that is already there (a name once learned is never silently flipped to someone
// else), and re-reads storage right before writing, one write at a time. Returns the full map.
let nameQueue = Promise.resolve();
export function mergeEmailNames(found) {
  nameQueue = nameQueue.catch(() => {}).then(async () => {
    const cur = await getEmailNames();
    const fresh = Object.entries(found || {}).filter(([k]) => !cur[k]);
    if (!fresh.length) return cur;
    const next = { ...cur, ...Object.fromEntries(fresh) };
    await saveEmailNames(next);
    return next;
  });
  return nameQueue;
}
