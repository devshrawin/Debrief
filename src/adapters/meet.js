// Google Meet page reader. Meet's markup is not a public API and its class names change, so this relies
// on ARIA labels, roles and text structure, with several fallbacks. `diagnose()` reports what was found
// so a detection problem can be seen (and fixed) instead of failing silently.
import { meetingEnded } from '../meetend.js';
import * as chat from './chat.js';
import { isIconText, isMenuText, personOfTile } from '../iconText.js';

const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/ /g, ' ').trim();
const lines = (el) => text(el).split(/\n+/).map((l) => l.trim()).filter(Boolean);
const NOT_A_NAME = /^(you|your|presenting|pinned|unpin|pin|mute|unmute|muted|more options|more|host|co-host|\d+|\d+ more|\+\d+|raised hand|lower hand|audio|video|camera|microphone|remove|admit|deny|in the meeting|contributors|people|participants|visible|backgrounds?)$/i;

function cleanName(raw) {
  if (isMenuText(raw)) return '';
  const n = personOfTile(String(raw || '').replace(/\s*\((you|host|presenting|co-host)\)\s*$/i, '').replace(/\s+/g, ' ')).trim();
  if (!n || n.length > 60 || isIconText(n) || isMenuText(n) || NOT_A_NAME.test(n) || /^[\d\s:.-]+$/.test(n)) return '';
  return n;
}

// ---- microphone state -------------------------------------------------------------------------
export function micButton(doc) {
  const withAttr = [...doc.querySelectorAll('button[data-is-muted], [role="button"][data-is-muted]')];
  const labelled = withAttr.find((b) => /microphone|mic\b/i.test(b.getAttribute('aria-label') || ''));
  if (labelled) return { el: labelled, muted: labelled.getAttribute('data-is-muted') === 'true' };
  // Meet shown in another language: the labels do not say "microphone", but the microphone toggle is the first
  // of the two buttons that carry data-is-muted (camera is the second) and neither mentions a camera in English.
  const toggles = withAttr.filter((b) => !/camera|video|cam\b/i.test(b.getAttribute('aria-label') || ''));
  if (!labelled && withAttr.length === 2 && toggles.length >= 1) return { el: toggles[0], muted: toggles[0].getAttribute('data-is-muted') === 'true' };
  const byLabel = [...doc.querySelectorAll('button[aria-label]')].find((b) => /turn (on|off) microphone/i.test(b.getAttribute('aria-label')));
  if (byLabel) return { el: byLabel, muted: /turn on/i.test(byLabel.getAttribute('aria-label')) };
  // Meet reworded its buttons: any button whose label is about the microphone, read by the verb ("Unmute", "Turn on" = muted now)
  const word = [...doc.querySelectorAll('button[aria-label], [role="button"][aria-label]')].find((b) => {
    const l = b.getAttribute('aria-label') || '';
    return /(mic|microphone)/i.test(l) && !/camera|video|speaker|audio output|settings|effects|more options|captions/i.test(l) && /(un)?mute|turn (on|off)|(enable|disable)/i.test(l);
  });
  if (word) {
    const l = word.getAttribute('aria-label');
    const pressed = word.getAttribute('aria-pressed');
    return { el: word, muted: /unmute|turn on|enable/i.test(l) ? true : /mute|turn off|disable/i.test(l) ? false : pressed === 'true' };
  }
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

// Writes one plain line in the meeting chat (the recording notice). Never throws.
export async function postNotice(doc, msg, opts) {
  try {
    return await chat.postNotice(doc, msg, opts);
  } catch (e) {
    return { ok: false, why: `chat error: ${e?.message || e}` };
  }
}

// ---- presenting -------------------------------------------------------------------------------
// Someone sharing their screen shows up as a label on a button, a heading or a status line ("Priya Nair is presenting",
// "You are presenting", "Stop presenting"). Only those places are read: a chat message that says the same words must not count.
const PRESENTING = /is presenting|presentation from|presentation\s*\(|you are presenting|you're presenting|stop presenting/i;
const YOU_PRESENT = /you are presenting|you're presenting|stop presenting/i;
const CHAT_SCOPE = '[role="textbox"], textarea, [contenteditable="true"], [role="log"], [role="complementary"], aside, [aria-label*="chat" i], [aria-label*="message" i]';

function presenterName(s) {
  const m = s.match(/^(.+?)\s+is presenting\b/i) || s.match(/\bpresentation\s*\(([^)]+)\)/i) || s.match(/(?:un)?pin\s+(.+?)['\u2019]s presentation/i) || s.match(/presentation from\s+(.+)$/i);
  const raw = m?.[1] || '';
  return /^(your|someone|somebody|a participant)\b/i.test(raw) ? '' : cleanName(raw);
}

// -> { on, name } (name 'You' when it is you), or null when it cannot be told (not in a call). `call`: the caller's own answer
// to inCall(doc), when it already has one (it is the costly part of the question).
// The pill asks every few seconds, so this stays cheap: labels and titles are read first (attributes, no layout); the text of
// small elements only when no label said it, and never textContent of a big region (a chat, a participants list).
const BIG = 200;
export function presenting(doc, call) {
  if (!(call ?? inCall(doc))) return null;
  let found = false;
  let name = null;
  const see = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 100 || !PRESENTING.test(t)) return null;
    found = true;
    if (YOU_PRESENT.test(t)) return { on: true, name: 'You' };
    name ||= presenterName(t) || null;
    return null;
  };
  for (const el of doc.querySelectorAll('[aria-label], [title]')) {
    if (el.closest(CHAT_SCOPE)) continue;
    const you = see(el.getAttribute('aria-label')) || see(el.getAttribute('title'));
    if (you) return you;
  }
  if (!found) {
    for (const el of doc.querySelectorAll('button, [role="button"], h1, h2, h3, [role="heading"], [role="status"], [role="alert"]')) {
      const raw = el.textContent || '';
      if (raw.length > BIG || el.closest(CHAT_SCOPE)) continue;
      const you = see(raw);
      if (you) return you;
    }
  }
  return { on: found, name: found ? name : null };
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
    chat: chat.diagnoseChat(doc),
    inCall: inCall(doc) ? 'yes, a call is on' : 'no call detected (lobby or not joined yet)',
    presenting: (() => {
      const p = presenting(doc);
      return !p ? 'unknown (no call detected)' : p.on ? `yes${p.name ? `, ${p.name}` : ', name not read'}` : 'no one is presenting';
    })(),
    endScreen: s.ended ? 'the end-of-meeting screen is showing' : 'no (normal while in a call)',
  };
}
