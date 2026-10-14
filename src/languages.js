// Languages Debrief can be told to expect in a meeting. The user picks any number of them.

export const LANGUAGES = [
  { code: 'en', name: 'English', bcp: 'en-IN', script: 'Latin script' },
  { code: 'hi', name: 'Hindi', bcp: 'hi-IN', script: 'Devanagari' },
  { code: 'ml', name: 'Malayalam', bcp: 'ml-IN', script: 'Malayalam script' },
  { code: 'ta', name: 'Tamil', bcp: 'ta-IN', script: 'Tamil script' },
  { code: 'te', name: 'Telugu', bcp: 'te-IN', script: 'Telugu script' },
  { code: 'kn', name: 'Kannada', bcp: 'kn-IN', script: 'Kannada script' },
  { code: 'mr', name: 'Marathi', bcp: 'mr-IN', script: 'Devanagari' },
  { code: 'bn', name: 'Bengali', bcp: 'bn-IN', script: 'Bengali script' },
  { code: 'gu', name: 'Gujarati', bcp: 'gu-IN', script: 'Gujarati script' },
  { code: 'pa', name: 'Punjabi', bcp: 'pa-IN', script: 'Gurmukhi' },
  { code: 'or', name: 'Odia', bcp: 'or-IN', script: 'Odia script' },
  { code: 'ur', name: 'Urdu', bcp: 'ur-IN', script: 'Urdu (Arabic) script' },
  { code: 'es', name: 'Spanish', bcp: 'es-ES', script: 'Latin script' },
  { code: 'fr', name: 'French', bcp: 'fr-FR', script: 'Latin script' },
  { code: 'de', name: 'German', bcp: 'de-DE', script: 'Latin script' },
  { code: 'pt', name: 'Portuguese', bcp: 'pt-BR', script: 'Latin script' },
  { code: 'ru', name: 'Russian', bcp: 'ru-RU', script: 'Cyrillic' },
  { code: 'ar', name: 'Arabic', bcp: 'ar-XA', script: 'Arabic script' },
  { code: 'zh', name: 'Chinese (Mandarin)', bcp: 'zh-CN', script: 'Chinese characters' },
  { code: 'ja', name: 'Japanese', bcp: 'ja-JP', script: 'Japanese script' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const LEGACY = { auto: ['en', 'hi', 'ml'], hinglish: ['hi', 'en'], malayalam: ['ml', 'en'] };

// What the user explicitly chose, or null for "automatic". Reads the list, or the old single setting.
export function chosenLanguages(settings) {
  const list = settings?.meetingLanguages;
  if (Array.isArray(list) && list.length) return list.map((c) => BY_CODE.get(c)).filter(Boolean);
  const legacy = settings?.meetingLanguage;
  return legacy && legacy !== 'auto' && LEGACY[legacy] ? LEGACY[legacy].map((c) => BY_CODE.get(c)) : null;
}

// The languages to describe to the models: the chosen ones, or Hindi, English and Malayalam when automatic.
export const languagesOf = (settings) => chosenLanguages(settings) || LEGACY.auto.map((c) => BY_CODE.get(c));

// Options for a "language of the minutes" menu.
export const minutesLanguageOptions = () => [...LANGUAGES.map((l) => ({ value: l.code === 'hi' ? 'Hindi (Devanagari)' : l.name, label: l.code === 'hi' ? 'Hindi (Devanagari)' : l.name })), { value: 'the same language mix used in the meeting', label: 'Same as the meeting' }];

const names = (langs) => (langs.length <= 1 ? langs[0]?.name || '' : `${langs.slice(0, -1).map((l) => l.name).join(', ')} and ${langs.at(-1).name}`);
export { names as joinNames };

// One sentence for the speech and minutes prompts.
export function languageHint(langs) {
  if (!langs.length) return '';
  const scripts = langs.filter((l) => l.code !== 'en').map((l) => `${l.name} in ${l.script}`);
  const mix = langs.length > 1 ? `It may mix ${names(langs)}` : `It is in ${langs[0].name}`;
  return `${mix}: write ${scripts.length ? scripts.join(', ') : 'English'}${langs.some((l) => l.code === 'en') && scripts.length ? ' and English words in English' : ''}.`;
}

// Language codes for Gemini's transcription model. Everything selected, in the order chosen; none = let it detect.
export const geminiCodes = (langs) => (langs?.length ? langs.map((l) => l.bcp) : null);

// A single non-English language lets providers that take one language narrow it down.
export function singleLanguage(langs) {
  const other = langs.filter((l) => l.code !== 'en');
  return other.length === 1 ? other[0] : null;
}

// Languages Sarvam can be pinned to.
export const SARVAM_CODES = new Set(['hi', 'ml', 'ta', 'te', 'kn', 'mr', 'bn', 'gu', 'pa', 'or', 'en']);
