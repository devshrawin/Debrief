// Small pure helpers for the Settings page (no DOM, no chrome.*), so they can be tested in Node.

// Number settings: the range each one is clamped to, and what it falls back to when the box is empty or not a number.
export const NUMERIC = {
  keepAudioDays: { min: 0, max: 365, fallback: 14 },
  screenNotesEverySec: { min: 10, max: 300, fallback: 30 },
};

export function clampNum(value, { min, max, fallback }) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (String(value ?? '').trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Fields that only mean something while another switch is on: dependent id -> the switch it follows.
export const DEPENDENTS = {
  keepAudioDays: 'keepAudio',
  screenNotesEverySec: 'screenNotes',
  consentText: 'consentNotice',
  nudgeSkipOneOnOne: 'recordNudge',
};

export const backupFileName = (d = new Date()) => `debrief-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;

export function formatMB(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  return `${mb >= 10 || mb === 0 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What a backup file holds, read from the parsed JSON without trusting it.
export function describeBackup(data) {
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(data) || data.app !== 'debrief') return null;
  return {
    meetings: Array.isArray(data.meetings) ? data.meetings.length : 0,
    settings: isObj(data.settings),
    voices: Array.isArray(data.voices) ? data.voices.length : 0,
  };
}

// Slack and Teams incoming webhooks take { text }; everything else gets the JSON the minutes are sent as.
export function isChatHookUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'hooks.slack.com' || h.includes('.webhook.office.com') || h === 'outlook.office.com' || h.endsWith('.outlook.office.com');
  } catch {
    return false;
  }
}

export const webhookTestBody = (url) => (isChatHookUrl(url) ? { text: 'Debrief test: this address is set up to receive minutes.' } : { app: 'debrief', version: 1, event: 'test' });

export const originPattern = (url) => `${new URL(String(url).trim()).origin}/*`;

const FREE_MAIL = /(^|\.)(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|rediffmail|zoho|gmx|mail)\.[a-z.]+$/i;
// True when the share guard cannot tell who is outside the organisation: no domains listed, and the address it would fall back to is empty or a free-mail one.
export function guardCannotTell({ guard, myOrgDomains, emailTo }) {
  if (!guard) return false;
  if (String(myOrgDomains || '').split(/[,\s;]+/).some(Boolean)) return false;
  const first = String(emailTo || '').split(/[,\s;]+/).find(Boolean) || '';
  const domain = first.includes('@') ? first.split('@').pop().toLowerCase() : '';
  return !domain || FREE_MAIL.test(domain);
}

// Which settings field a model finding fills in. A backup-chain finding has no field of its own.
const MODEL_FIELDS = {
  speech: { gemini: 'sttGeminiModel', sarvam: 'sarvamModel', deepgram: 'deepgramModel', openai: 'sttModel' },
  minutes: { gemini: 'geminiModel', anthropic: 'anthropicModel', openai: 'oaModel' },
};
export const modelFieldFor = (finding) => MODEL_FIELDS[finding?.role]?.[finding?.provider] || '';
