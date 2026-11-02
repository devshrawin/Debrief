// Names the user puts on single transcript lines of ONE meeting (meeting.lineNames), when voice recognition did not know who
// spoke, or guessed wrong. A line is found again by where it starts: "<source>@<tenths of a second>". The names are never
// copied to voice profiles or other meetings. They win over the model's guess everywhere the transcript is shown or used.

export const lineKey = (l) => `${l?.src === 'me' ? 'me' : 'others'}@${Math.round((Number(l?.t) || 0) * 10)}`;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

// The map as stored: only real keys with real names.
export function cleanLineNames(map) {
  const out = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map)) {
      const name = clean(v);
      if (/^(me|others)@-?\d+$/.test(k) && name) out[k] = name;
    }
  }
  return out;
}

export const lineNameOf = (map, l) => (map && Object.prototype.hasOwnProperty.call(map, lineKey(l)) ? clean(map[lineKey(l)]) : '');

// A new map with this line named (an empty name removes it). Never changes the map it is given.
export function setLineName(map, l, name) {
  const next = { ...cleanLineNames(map) };
  const n = clean(name);
  if (n) next[lineKey(l)] = n;
  else delete next[lineKey(l)];
  return next;
}

// The names used on this meeting's lines, most recently added last, each once (for the menu and for the attendee list).
export const usedNames = (map) => [...new Set(Object.values(cleanLineNames(map)))];
