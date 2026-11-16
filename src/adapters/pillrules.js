// What the Meet pill decides, kept apart from the page so node can test it: when to post the recording notice in the
// chat, when to ask "record this meeting?", and when to tell the background someone is presenting. No page, no chrome APIs.
import { shouldNudge, nudgeText } from '../nudge.js';

// Same cleaning the background applies to a tab title when a recording starts, so a reminder matches by the same words.
export const cleanTitle = (t = '') => t.replace(/^Meet\s*[-–]\s*/i, '').replace(/\s*[-–]\s*Google Meet$/i, '').trim() || 'Meeting';

// Reasons worth a second try (the chat panel may still have been opening); anything else will not change in 20 s.
export const TRANSIENT = ['could not find the chat box', 'the message did not send'];
export const RETRY_MS = 20000;
export const noticeFailed = (why) => `Debrief could not post the recording notice in the chat (${why}). Please tell people yourself.`;

// One attempt per recording, plus one retry for a transient failure. Only the final outcome is reported (the background
// keeps the first report it gets, and a reported notice is never posted again, even after a page reload).
export function noticeController() {
  let key = null;
  let tries = 0;
  let retryAt = 0;
  let over = false;
  let busy = false;
  return {
    // true = post now. The caller must then call finish().
    begin({ now, recKey, adapterId, room, paused, inCall, notice }) {
      if (recKey !== key) {
        key = recKey;
        tries = 0;
        retryAt = 0;
        over = false;
        busy = false;
      }
      if (!recKey || over || busy) return false;
      if (!notice?.on || notice.done || !notice.text) return false;
      if (adapterId !== 'meet') return false; // other meeting apps have no chat we can write in
      if (room) return false; // an in-person recording has no meeting chat
      if (paused || !inCall) return false; // not while paused; only once the page is really in the call
      if (tries >= 2 || (tries === 1 && now < retryAt)) return false;
      busy = true;
      tries++;
      return true;
    },
    // r = what postNotice returned. -> { report, alert, retry }
    finish(r, now) {
      busy = false;
      const ok = !!r?.ok;
      const why = String(r?.why || (ok ? '' : 'unknown')).slice(0, 120);
      if (!ok && TRANSIENT.includes(why) && tries < 2) {
        retryAt = now + RETRY_MS;
        return { report: null, alert: null, retry: true };
      }
      over = true;
      return { report: { ok, posted: !!r?.posted, why }, alert: ok ? null : noticeFailed(why), retry: false };
    },
  };
}

// The "record this meeting?" card: shown once per call, gone when recording starts or the call ends.
export function nudgeController() {
  let joinedAt = null; // when the pill first saw this call
  let showing = null;
  const seen = new Set();
  const dismissed = new Set();
  return {
    // -> { key, text } while the card should be up, else null
    step({ now, recording, inCall, cfg, title, url, participants = [], shortcut }) {
      if (!inCall) {
        joinedAt = null;
        showing = null;
        return null;
      }
      joinedAt ??= now;
      if (recording || !cfg?.on) {
        showing = null;
        return null;
      }
      const d = shouldNudge({
        settings: { recordNudge: true, nudgeSkipOneOnOne: cfg.skipOneOnOne !== false, meetingTypes: cfg.meetingTypes || [] },
        title: cleanTitle(title).slice(0, 100),
        url,
        participants,
        recording: false,
        dismissedKeys: [...(cfg.dismissed || []), ...dismissed],
        now,
        joinedAt,
      });
      if (!d.nudge) {
        showing = null;
        return null;
      }
      if (showing !== d.key && seen.has(d.key)) return null; // it was up once already for this call
      seen.add(d.key);
      showing = d.key;
      return { key: d.key, text: nudgeText(d.typeName, shortcut || 'Alt+Shift+M') };
    },
    dismiss(key) {
      dismissed.add(key);
      if (showing === key) showing = null;
    },
  };
}

// Tells the background about presenting only when it changes, and once after a recording starts.
export function presentingReporter() {
  let lastRec = null;
  let last = '';
  return {
    // cur = adapter.presenting() ({ on, name } or null for "cannot tell") -> { on, name } to send, or null
    step(recKey, cur) {
      if (!recKey) {
        lastRec = null;
        last = '';
        return null;
      }
      if (!cur) return null;
      const on = !!cur.on;
      const name = on && cur.name ? String(cur.name).slice(0, 60) : null;
      const sig = `${on}|${name || ''}`;
      if (recKey === lastRec && sig === last) return null;
      lastRec = recKey;
      last = sig;
      return { on, name };
    },
  };
}
