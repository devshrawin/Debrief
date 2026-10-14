// Google Meet page reader. Meet's markup is not a public API and its class names change, so this relies
// on ARIA labels, roles and text structure, with several fallbacks. `diagnose()` reports what was found
// so a detection problem can be seen (and fixed) instead of failing silently.
import { meetingEnded } from '../meetend.js';
import { isIconText } from '../iconText.js';

const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/ /g, ' ').trim();
const lines = (el) => text(el).split(/\n+/).map((l) => l.trim()).filter(Boolean);
const NOT_A_NAME = /^(you|your|presenting|pinned|unpin|pin|mute|unmute|muted|more options|more|host|co-host|\d+|\d+ more|\+\d+|raised hand|lower hand|audio|video|camera|microphone|remove|admit|deny|in the meeting|contributors|people|participants|visible|backgrounds?)$/i;

function cleanName(raw) {
  const n = String(raw || '').replace(/\s*\((you|host|presenting|co-host)\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 60 || isIconText(n) || NOT_A_NAME.test(n) || /^[\d\s:.-]+$/.test(n)) return '';
  return n;
}

// ---- microphone state -------------------------------------------------------------------------
export function micButton(doc) {
  const withAttr = [...doc.querySelectorAll('button[data-is-muted], [role="button"][data-is-muted]')];
  const labelled = withAttr.find((b) => /microphone|mic\b/i.test(b.getAttribute('aria-label') || ''));
  if (labelled) return { el: labelled, muted: labelled.getAttribute('data-is-muted') === 'true' };
  const byLabel = [...doc.querySelectorAll('button[aria-label]')].find((b) => /turn (on|off) microphone/i.test(b.getAttribute('aria-label')));
  if (byLabel) return { el: byLabel, muted: /turn on/i.test(byLabel.getAttribute('aria-label')) };
  return null;
}

// ---- participants -----------------------------------------------------------------------------
// From the People panel when it is open, else from the video tiles currently on screen.
export function readParticipants(doc) {
  const names = new Set();
  const panel = [...doc.querySelectorAll('[role="list"]')].find((l) => /participants|people|in the meeting|contributors/i.test(l.getAttribute('aria-label') || ''));
  if (panel) {
    for (const item of panel.querySelectorAll('[role="listitem"]')) {
      const n = cleanName(item.getAttribute('aria-label')) || cleanName(lines(item)[0]);
      if (n) names.add(n);
    }
  }
  if (!names.size) {
    for (const tile of doc.querySelectorAll('[data-participant-id]')) {
      const self = tile.querySelector('[data-self-name]')?.getAttribute('data-self-name');
      const n = cleanName(self) || cleanName(lines(tile).find((l) => cleanName(l)));
      if (n) names.add(n);
    }
  }
  return [...names];
}

// ---- live captions ----------------------------------------------------------------------------
export function captionsRegion(doc) {
  return [...doc.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]')].find((r) => /caption/i.test(r.getAttribute('aria-label') || '')) || null;
}

// Each caption block is: speaker name, then what they said (an avatar image may come first).
export function readCaptions(doc) {
  const region = captionsRegion(doc);
  if (!region) return [];
  const blocks = [...region.querySelectorAll(':scope > div, :scope > div > div')].filter((b) => lines(b).length >= 2 && !b.querySelector(':scope > div > div > div > div > div'));
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    const l = lines(b);
    const name = cleanName(l[0]);
    const said = l.slice(1).join(' ').trim();
    const key = `${name}|${said}`;
    if (name && said && !seen.has(key)) {
      seen.add(key);
      out.push({ name, text: said });
    }
  }
  return out;
}

export function captionsButton(doc) {
  return [...doc.querySelectorAll('button[aria-label]')].find((b) => /turn on captions|captions \(c\)|show captions/i.test(b.getAttribute('aria-label') || '')) || null;
}

// ---- end of meeting ---------------------------------------------------------------------------
export function endScreen(doc) {
  if (micButton(doc) && [...doc.querySelectorAll('button[aria-label]')].some((b) => /leave call/i.test(b.getAttribute('aria-label')))) return false;
  const texts = [...doc.querySelectorAll('button, [role="button"], h1, h2, [role="heading"]')].slice(0, 300).map(text);
  return meetingEnded(texts);
}

export function inCall(doc) {
  const leave = [...doc.querySelectorAll('button[aria-label]')].some((b) => /leave call/i.test(b.getAttribute('aria-label')));
  return !!(micButton(doc) && leave && !endScreen(doc));
}

export function snapshot(doc) {
  return { mic: micButton(doc), participants: readParticipants(doc), captions: readCaptions(doc), ended: endScreen(doc) };
}

export function diagnose(doc) {
  const s = snapshot(doc);
  return {
    app: 'Google Meet',
    micButton: s.mic ? `found, ${s.mic.muted ? 'muted' : 'unmuted'}` : 'NOT found',
    participants: s.participants.length ? `${s.participants.length} found: ${s.participants.slice(0, 6).join(', ')}` : 'none found (open the People panel, or join the call first)',
    captions: captionsRegion(doc) ? `region found, ${s.captions.length} caption block(s) now${s.captions[0] ? `, e.g. "${s.captions[0].name}"` : ''}` : 'captions are not showing (turn them on with the CC button)',
    captionsButton: captionsButton(doc) ? 'found' : 'not found (captions may already be on)',
    inCall: inCall(doc) ? 'yes, a call is on' : 'no call detected (lobby or not joined yet)',
    endScreen: s.ended ? 'the end-of-meeting screen is showing' : 'no (normal while in a call)',
  };
}
