// Sharing voices between people: a small JSON file of fingerprints (numbers), never audio.
import { ENROL, newId } from './enrol.js';

export const SHARE_FORMAT = 'debrief-voices';
export const MODEL_ID = 'wespeaker-resnet34-lm';
const B64_256 = /^(?:[A-Za-z0-9+/]{4}){85}[A-Za-z0-9+/]{2}==$|^(?:[A-Za-z0-9+/]{4}){85}[A-Za-z0-9+/]{3}=$/; // 256 bytes as base64

export function exportVoices(list, ids) {
  const pick = ids ? list.filter((p) => ids.includes(p.id)) : list;
  return JSON.stringify(
    {
      format: SHARE_FORMAT,
      version: 1,
      model: MODEL_ID,
      exported: new Date().toISOString(),
      people: pick.map((p) => ({ name: p.name, lang: p.lang || 'en', langs: p.langs || [p.lang || 'en'], secs: p.secs || 0, centroid: p.centroid, windows: p.windows || [] })),
    },
    null,
    1
  );
}

// Reads a shared file. Returns { people, problems }: anything that is not a valid fingerprint is dropped and
// explained, never half-imported. A fingerprint made by a different model cannot be compared, so is refused.
export function parseImport(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { people: [], problems: ['This is not a Debrief voices file (it could not be read).'] };
  }
  if (o?.format !== SHARE_FORMAT || !Array.isArray(o.people)) return { people: [], problems: ['This is not a Debrief voices file.'] };
  if (o.model !== MODEL_ID) return { people: [], problems: [`These voices were made with a different speaker model (${String(o.model).slice(0, 40)}), so they cannot be matched here.`] };
  const people = [];
  const problems = [];
  for (const p of o.people.slice(0, 200)) {
    const name = String(p?.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) {
      problems.push('A person without a name was skipped.');
      continue;
    }
    if (typeof p.centroid !== 'string' || !B64_256.test(p.centroid)) {
      problems.push(`${name}: the fingerprint is damaged, skipped.`);
      continue;
    }
    const windows = Array.isArray(p.windows) ? p.windows.filter((w) => typeof w === 'string' && B64_256.test(w)).slice(0, ENROL.maxWindows * 2) : [];
    const lang = String(p.lang || 'en').slice(0, 8);
    const langs = Array.isArray(p.langs) ? p.langs.filter((l) => typeof l === 'string').map((l) => l.slice(0, 8)).slice(0, 6) : [];
    people.push({ name, lang, langs: langs.length ? langs : [lang], secs: Math.max(0, Math.min(3600, Number(p.secs) || 0)), centroid: p.centroid, windows });
  }
  return { people, problems };
}

// Adds imported people. A name that already exists is kept as it is unless replace is true.
export function mergeImport(list, incoming, { replace = false } = {}) {
  const next = [...list];
  const added = [];
  const replaced = [];
  const skipped = [];
  for (const p of incoming) {
    const i = next.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (i >= 0 && !replace) {
      skipped.push(p.name);
      continue;
    }
    const rec = { ...p, id: i >= 0 ? next[i].id : newId(), created: i >= 0 ? next[i].created : Date.now(), updated: Date.now(), imported: true };
    if (i >= 0) {
      next[i] = rec;
      replaced.push(p.name);
    } else {
      next.push(rec);
      added.push(p.name);
    }
  }
  return { list: next, added, replaced, skipped };
}
