import { clearAllAudio } from './voice/samples.js';
// Settings + meeting records in chrome.storage.local; recorder state in chrome.storage.session.

export const DEFAULTS = {
  myName: '',
  captureMic: true,
  meetingLanguages: [], // languages to expect (codes from languages.js); empty = automatic
  meetingLanguage: 'auto', // older single setting (auto | hinglish | malayalam), still honoured when the list is empty
  pillOnPage: false, // also show the pill inside the Meet page
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
  usagePrices: '', // one "model=USD per 1M input,USD per 1M output" per line
  dictAutoAlias: false, // accept clear-cut learned fixes (3+ sightings) without asking
  dictionary: '', // names and terms, one per line: Right | misheard, as, this
  minutesMode: 'thorough', // thorough = extract, write, then check; quick = one pass
  minutesFormat: 'amnex', // amnex = official Amnex template (Print/PDF, Word, email); standard = Debrief's own layout
  myOrgDomains: '', // email domains of the System Integrator side (comma separated); empty = the domain of "Send to", else one list
  peopleDirectory: '', // one per line: Name | Honorific | Department | Designation | Organisation [| Chair]
  shareList: '', // default people to share the minutes with
  shareGroups: '', // per recurring meeting: "title words | a@x.com, b@y.com"
  shareMode: 'review', // review = only I get it until I press Share; auto = send to them too
  shareHow: 'to', // to | cc | bcc
  shareDomains: false, // script helper: allow whole company domains instead of single addresses
  calendarLookup: true, // ask the relay who was invited (needs the calendar permission)
  meetCaptions: 'read', // read speaker names from Meet's captions: off | read (when you have captions on) | auto (turn them on)
  otherSites: true, // use the page features (amber dot, mute follow, auto-stop) on Zoom, Teams, Webex and other meeting apps
  voiceOn: false, // recognise who is speaking, using voices enrolled in Settings
  voiceSamples: false, // keep a short audio clip of each unnamed voice so it can be played to name it (off: no audio is kept)
  voiceLearn: false, // learn voices on its own from Meet's captions (needs captions read) and fingerprints of the meeting
  followMeetMute: true, // ignore my mic while Meet's own mic button is muted
  momLanguage: 'English',

  geminiKey: '', // shared by Gemini transcription and the Gemini MOM writer
  geminiKey2: '', // optional backup key from a different Google Cloud project
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

export async function getSettings() {
  const { settings, learned, voices } = await chrome.storage.local.get(['settings', 'learned', 'voices']);
  // Names learned from past meetings (not part of what the user typed) are used as spelling hints.
  const learnedNames = Object.entries(learned?.names || {}).sort((a, b) => a[1] - b[1]).map(([n]) => n).slice(-80);
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

const key = (id) => `meeting:${id}`;

export async function getMeeting(id) {
  const r = await chrome.storage.local.get(key(id));
  return r[key(id)] || null;
}

export async function saveMeeting(m) {
  await chrome.storage.local.set({ [key(m.id)]: m });
}

export async function listMeetings() {
  const { meetingIds = [] } = await chrome.storage.local.get('meetingIds');
  const r = await chrome.storage.local.get(meetingIds.map(key));
  return meetingIds.map((id) => r[key(id)]).filter(Boolean);
}

export async function addMeetingId(id) {
  const { meetingIds = [] } = await chrome.storage.local.get('meetingIds');
  await chrome.storage.local.set({ meetingIds: [id, ...meetingIds] });
}

export async function deleteMeeting(id) {
  const { meetingIds = [] } = await chrome.storage.local.get('meetingIds');
  await chrome.storage.local.set({ meetingIds: meetingIds.filter((x) => x !== id) });
  await chrome.storage.local.remove(key(id));
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

export async function saveVoices(list) {
  await chrome.storage.local.set({ voices: list });
}

// Deletes every enrolled voice, and the voice fingerprints kept inside saved meetings.
export async function forgetAllVoices() {
  await chrome.storage.local.remove('voices');
  await clearAllAudio().catch(() => {});
  const { meetingIds = [] } = await chrome.storage.local.get('meetingIds');
  const r = await chrome.storage.local.get(meetingIds.map(key));
  const changed = {};
  for (const id of meetingIds) {
    const m = r[key(id)];
    if (m && (m.voiceSegs || m.voiceModel)) {
      const { voiceSegs, voiceModel, ...rest } = m;
      changed[key(id)] = rest;
    }
  }
  if (Object.keys(changed).length) await chrome.storage.local.set(changed);
  return Object.keys(changed).length;
}

// Learned voices the user deleted and asked not to learn again: [{ name, centroid }].
export async function getBlockedVoices() {
  const { voiceBlock } = await chrome.storage.local.get('voiceBlock');
  return voiceBlock || [];
}

export async function saveBlockedVoices(list) {
  await chrome.storage.local.set({ voiceBlock: list.slice(-100) });
}
