// Google Meet draws its buttons with an icon font: the page text for an icon is its ligature name, for example
// "frame_person", "keep_off", "zoom_in" or "more_vert". Those must never be mistaken for a person's name.
// A real display name is not written lowercase_with_underscores and has no digits-only form.
export const isIconText = (s) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(s || '').trim());

// A presence map { name: [..] } without icon names (also cleans meetings saved before this fix).
export function cleanPresence(presence) {
  return Object.fromEntries(Object.entries(presence || {}).filter(([n]) => !isIconText(n)));
}
