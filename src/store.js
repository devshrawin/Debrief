// Settings + meeting records in chrome.storage.local; recorder state in chrome.storage.session.

export const DEFAULTS = {
  myName: '',
  captureMic: true,
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
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
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
