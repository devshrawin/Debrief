// Decides whether to remind the user to record this call. Pure: no page, no chrome APIs.
// A browser extension cannot start a tab recording by itself (Chrome only allows it after the user clicks the
// extension button or presses its shortcut), so all this can do is ask.
import { pickType } from './meetingtypes.js';
import { MEET_CODE } from './meetend.js';

const WAIT_FOR_PEOPLE_MS = 20000;

// One key per call: the Meet code when there is one, else the title and the day.
export function nudgeKey(title, url, now = Date.now()) {
  const code = String(url || '').match(MEET_CODE)?.[0];
  if (code) return `meet:${code.toLowerCase()}`;
  const day = new Date(now).toISOString().slice(0, 10);
  return `title:${String(title || '').replace(/\s+/g, ' ').trim().toLowerCase()}:${day}`;
}

// `joinedAt` (ms) is when the user joined; without it we do not wait for the participant list.
export function shouldNudge({ settings = {}, meetingTypes, title, url, participants = [], recording, dismissedKeys = [], now = Date.now(), joinedAt } = {}) {
  const key = nudgeKey(title, url, now);
  if (settings?.recordNudge === false) return { nudge: false, key, reason: 'reminders are off' };
  if (recording) return { nudge: false, key, reason: 'already recording' };
  if (dismissedKeys.includes(key)) return { nudge: false, key, reason: 'already shown for this call' };
  const type = pickType(settings?.meetingTypes ?? meetingTypes, { title, url });
  if (!type) return { nudge: false, key, reason: 'no meeting type matches' };
  if (settings?.nudgeSkipOneOnOne !== false) {
    const n = Array.isArray(participants) ? participants.length : 0;
    if (n >= 1 && n <= 2) return { nudge: false, key, typeName: type.name, reason: 'one-on-one' };
    if (n === 0 && Number.isFinite(joinedAt) && now - joinedAt < WAIT_FOR_PEOPLE_MS) return { nudge: false, key, typeName: type.name, reason: 'waiting for participants' };
  }
  return { nudge: true, key, typeName: type.name, reason: 'matches a meeting type' };
}

export function nudgeText(typeName, shortcut = 'Alt+Shift+M') {
  const what = typeName ? `This looks like your "${typeName}".` : 'This looks like a meeting you usually record.';
  return `${what} Press ${shortcut} or click the Debrief button to record it.`;
}
