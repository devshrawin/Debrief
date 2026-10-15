// Online meeting or a room? A tab on a meeting link is an online meeting (the call's audio comes from the tab, your
// voice from the microphone). Any other tab means you are recording something in the room, so the microphone is the
// meeting. The popup shows this as a switch with the detected side already chosen; the user can flip it.
import { isMeetingSite, siteFor } from './adapters/index.js';
import { MEET_CODE } from './meetend.js';

// A designated meeting link: a Google Meet with its code (not the Meet home page), or a page of another supported
// meeting app.
export function meetingFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname === 'meet.google.com') return MEET_CODE.test(u.pathname) ? { app: 'Google Meet' } : null;
  if (isMeetingSite(u.hostname)) return { app: siteFor(u.hostname)?.name || u.hostname };
  return null;
}

export const isMeetingUrl = (url) => !!meetingFor(url);

// The mode a recording starts in: the user's explicit choice (true / false) wins, otherwise decided by the link.
export const roomFor = (url, choice) => (typeof choice === 'boolean' ? choice : !isMeetingUrl(url));

// The sentence under the switch.
export function modeHint(url, room, chosen) {
  const m = meetingFor(url);
  if (chosen) return room ? 'In a room: your microphone is the meeting, so every voice on it is told apart.' : 'Online meeting: the call is recorded from this tab and your voice from your microphone.';
  return m
    ? `${m.app} detected: recording the call from this tab and your voice from your microphone.`
    : 'This is not a meeting link, so Debrief records the room through your microphone.';
}
