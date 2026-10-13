// Best-effort reader for other web meeting apps (Teams, Zoom web, Webex, Whereby, Jitsi...). It only
// looks at ARIA labels and visible button text, so it can work on many apps without app-specific code.
// Everything is optional: if nothing is recognised the manual controls still work.
import { meetingEnded } from '../meetend.js';

const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/ /g, ' ').trim();
const label = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-tid') || ''}`.trim();

// "Mute" means you are currently unmuted; "Unmute" means you are muted.
export function micButton(doc) {
  const candidates = [...doc.querySelectorAll('button, [role="button"], [role="switch"]')];
  for (const b of candidates) {
    const l = label(b);
    if (/(^|\b)(un-?mute)\b.{0,20}(mic|audio)?/i.test(l) && !/camera|video/i.test(l)) return { el: b, muted: true };
    if (/turn on (your )?(microphone|mic)/i.test(l)) return { el: b, muted: true };
  }
  for (const b of candidates) {
    const l = label(b);
    if (/(^|\b)mute\b.{0,20}(mic|audio)?/i.test(l) && !/camera|video|un-?mute/i.test(l)) return { el: b, muted: false };
    if (/turn off (your )?(microphone|mic)/i.test(l)) return { el: b, muted: false };
    if (/microphone/i.test(l) && b.getAttribute('aria-pressed') != null) return { el: b, muted: b.getAttribute('aria-pressed') === 'false' };
  }
  return null;
}

// A call is on when there is a mic button and a leave/end button and no end screen.
export function leaveButton(doc) {
  return [...doc.querySelectorAll('button, [role="button"]')].find((b) => /(^|\b)(leave|hang up|end)\b.{0,20}(call|meeting|session)?/i.test(`${label(b)} ${text(b)}`.trim()) && !/leave a message|end of/i.test(label(b))) || null;
}

export function inCall(doc) {
  return !!(micButton(doc) && leaveButton(doc) && !endScreen(doc));
}

export function endScreen(doc) {
  const texts = [...doc.querySelectorAll('button, [role="button"], h1, h2, h3, [role="heading"]')].slice(0, 300).map(text);
  return meetingEnded(texts) || texts.some((t) => /^(this )?(meeting|call) (has )?(been )?ended( by (the )?host)?\.?$/i.test(t.trim()));
}

export function snapshot(doc) {
  return { mic: micButton(doc), participants: [], captions: [], ended: endScreen(doc), inCall: inCall(doc) };
}

export function diagnose(doc, name = 'This meeting app') {
  const s = snapshot(doc);
  return {
    app: `${name} (experimental, generic detection)`,
    micButton: s.mic ? `found, ${s.mic.muted ? 'muted' : 'unmuted'}` : 'NOT found: use the manual mic switch',
    participants: 'not read for this app',
    captions: 'not read for this app',
    inCall: s.inCall ? 'yes, a call is on' : 'no call detected',
    endScreen: s.ended ? 'the end-of-meeting screen is showing' : 'no (normal while in a call)',
  };
}
