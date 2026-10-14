// Best-effort reader for other web meeting apps (Teams, Zoom web, Webex, Whereby, Jitsi...). It only
// looks at ARIA labels and visible button text, so it can work on many apps without app-specific code.
// Everything is optional: if nothing is recognised the manual controls still work.
import { meetingEnded } from '../meetend.js';

const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/ /g, ' ').trim();
const label = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-tid') || ''}`.trim();

// "Mute" means you are currently unmuted; "Unmute" means you are muted. Only a button whose whole label is
// a mute label counts (not "Unmute all", "Mute notifications", a participant's row or a video player's
// volume button), so another person's button can never be taken for yours.
const MUTE_LABEL = /^(un-?mute|mute)( my| the)?( (microphone|mic|audio))?( \(.*\))?$/i;
const OUTSIDE = '[role="list"], [role="listitem"], [role="dialog"], [role="menu"], video, [class*="player" i]';

export function micButton(doc) {
  const buttons = [...doc.querySelectorAll('button, [role="button"], [role="switch"]')].filter((b) => !b.closest(OUTSIDE));
  const names = (b) => [b.getAttribute('aria-label'), b.getAttribute('title'), text(b)].map((x) => (x || '').trim()).filter(Boolean);
  for (const b of buttons) {
    for (const n of names(b)) {
      if (/^turn on (my |your )?(microphone|mic)\b/i.test(n)) return { el: b, muted: true };
      if (/^turn off (my |your )?(microphone|mic)\b/i.test(n)) return { el: b, muted: false };
      const m = n.match(MUTE_LABEL);
      if (m) return { el: b, muted: /^un/i.test(m[1]) };
    }
    const l = (b.getAttribute('aria-label') || '').trim();
    if (/^microphone$/i.test(l) && b.getAttribute('aria-pressed') != null) return { el: b, muted: b.getAttribute('aria-pressed') === 'false' };
  }
  return null;
}

// A call is on when there is a mic button and a leave/end button and no end screen.
const LEAVE_LABEL = /^(leave|end|leave (call|meeting|session)|hang up|end (call|meeting|session)|end for (me|everyone|all)|end meeting for all)( \(.*\))?$/i;
export function leaveButton(doc) {
  return (
    [...doc.querySelectorAll('button, [role="button"]')].find((b) => !b.closest('[role="list"], [role="listitem"], [role="dialog"], [role="menu"]') && [b.getAttribute('aria-label'), b.getAttribute('title'), text(b)].some((n) => LEAVE_LABEL.test((n || '').trim()))) || null
  );
}

export function inCall(doc) {
  return !!(micButton(doc) && leaveButton(doc) && !endScreen(doc));
}

export function endScreen(doc) {
  // While the call controls are still on the page the call is not over, whatever else the page says.
  if (micButton(doc) && leaveButton(doc)) return false;
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
