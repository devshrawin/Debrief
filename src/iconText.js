// Google Meet draws its buttons with an icon font: the page text for an icon is its ligature name, for example
// "frame_person", "keep_off", "zoom_in" or "more_vert". Those must never be mistaken for a person's name.
// A real display name is not written lowercase_with_underscores and has no digits-only form.
export const isIconText = (s) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(s || '').trim());

// Text of Meet's own controls that sits inside a participant tile ("Pin Amal Raj to your main screen",
// "Unpin Amal Raj's presentation from your main screen", "Reframe", "Zoom in"). Never a person's name.
const MENU = /^(?:(?:un)?pin|spotlight|remove|mute|unmute|reframe|zoom (?:in|out)|minimi[sz]e|maximi[sz]e|full screen|more actions|add (?:a )?(?:person|people)|keep|send a message)\b.*$/i;
// Sentences and headings from Meet's own panels ("You can't remotely mute this participant", "Backgrounds and effects"):
// a person's name is not a sentence, so these are rejected as UI text.
const UI_PHRASE = /(?:\bcan['\u2019]?t\b|\bcannot\b|\bremotely\b|\bsomeone else\b|\bthis participant\b|^you (?:are|have|will|can)\b|^(?:backgrounds?|effects?|captions?|activities|host controls|meeting details|participants|people|in the call|contributors|visual effects|apply visual effects|more options|raise hand|lower hand|present now|share screen|leave call|end call|chat|reactions?)(?:\s+(?:and|&)\s+\w+)?$)/i;
export const isMenuText = (s) => {
  const t = String(s || '').trim();
  if (UI_PHRASE.test(t) || t.split(/\s+/).length > 6) return true;
  return /\b(?:to|from) your main screen\b/i.test(t) || /^(?:reframe|zoom in|zoom out|keep|pin|unpin)$/i.test(t) || /^(?:un)?pin\s/i.test(t) || (MENU.test(t) && /\b(?:screen|presentation|participant|tile|view)\b/i.test(t));
};

// A tile for someone's presentation reads "Amal Raj's presentation": that is Amal Raj.
export const personOfTile = (s) => String(s || '').replace(/[’']s presentation\s*$/i, '').trim();

// A presence map { name: [..] } without icon names (also cleans meetings saved before this fix).
export function cleanPresence(presence) {
  return Object.fromEntries(Object.entries(presence || {}).filter(([n]) => !isIconText(n) && !isMenuText(n)));
}
