// Enrolment: turns about 20 seconds of someone reading aloud into a voice fingerprint.
// The audio is cut into 1.5 to 4 second pieces of speech, each piece is fingerprinted, and what is kept is
// the average fingerprint plus a few individual ones. The audio itself is never kept: only these numbers.
import { VoiceTracker, SR } from './tracker.js';
import { mean, pack, unpack, cosine } from './match.js';

export const ENROL = {
  targetSec: 20, // what the screen asks for
  minSpeechSec: 8, // less speech than this and the fingerprint would be unreliable
  minPieces: 4,
  maxWindows: 10, // individual fingerprints kept next to the average
  minConsistency: 0.35, // a piece this unlike the rest (a cough, a second voice) is left out
};

// Reading prompts. Two languages so the fingerprint can be made in the language a person mostly speaks.
export const PROMPTS = {
  en: 'Please read this aloud at your normal pace and volume. When the team met on Tuesday, we reviewed the registration data, checked the mapping file for each scheme, and agreed that the upload would be ready by Friday afternoon. If anything looks different from last week, please tell me now so we can fix it before the review. Thank you everyone, that is all for today.',
  ml: 'ദയവായി സാധാരണ വേഗത്തിലും ശബ്ദത്തിലും ഇത് ഉറക്കെ വായിക്കുക. ചൊവ്വാഴ്ച ടീം യോഗം ചേർന്നപ്പോൾ ഞങ്ങൾ രജിസ്ട്രേഷൻ വിവരങ്ങൾ പരിശോധിച്ചു, ഓരോ സ്കീമിനുമുള്ള മാപ്പിംഗ് ഫയൽ നോക്കി, വെള്ളിയാഴ്ച ഉച്ചയ്ക്ക് മുമ്പ് അപ്‌ലോഡ് തയ്യാറാകുമെന്ന് തീരുമാനിച്ചു. കഴിഞ്ഞ ആഴ്ചയിൽ നിന്ന് എന്തെങ്കിലും വ്യത്യാസം കണ്ടാൽ ദയവായി ഇപ്പോൾ പറയുക. എല്ലാവർക്കും നന്ദി, ഇന്നത്തേക്ക് ഇത്രമാത്രം.',
};

// pcm: Float32Array at 16 kHz. Returns the pieces of speech found, [{ t0, t1, pcm }].
export function speechPieces(pcm) {
  const out = [];
  const tracker = new VoiceTracker((s) => out.push(s));
  for (let i = 0; i + 2048 <= pcm.length; i += 2048) tracker.push(pcm.subarray(i, i + 2048));
  tracker.flush();
  return out;
}

// embed(pcm) -> Promise<Float32Array|null>. Returns { ok, ... }: on success the person's fingerprint fields,
// otherwise a plain reason to show the user.
export async function buildPrint(pcm, embed) {
  const pieces = speechPieces(pcm);
  const speechSec = pieces.reduce((a, p) => a + (p.t1 - p.t0), 0);
  if (speechSec < ENROL.minSpeechSec || pieces.length < ENROL.minPieces) {
    return { ok: false, speechSec, reason: `Only ${speechSec.toFixed(0)} seconds of clear speech were heard (about ${ENROL.minSpeechSec} are needed). Move closer to the microphone, cut background noise, and read the whole text.` };
  }
  const embs = [];
  for (const p of pieces) {
    const e = await embed(p.pcm.slice());
    if (e) embs.push(e);
  }
  if (embs.length < ENROL.minPieces) return { ok: false, speechSec, reason: 'The voice model could not process enough of the recording. Try again.' };
  // leave out pieces that do not sound like the rest (someone else speaking, a cough, a knock)
  let keep = embs;
  const first = mean(embs);
  const kept = embs.filter((e) => cosine(e, first) >= ENROL.minConsistency);
  if (kept.length >= ENROL.minPieces) keep = kept;
  const centroid = mean(keep);
  const spread = keep.map((e) => cosine(e, centroid));
  const consistency = spread.reduce((a, b) => a + b, 0) / spread.length;
  // keep a spread of individual samples, not the first few
  const step = Math.max(1, Math.floor(keep.length / ENROL.maxWindows));
  const windows = keep.filter((_, i) => i % step === 0).slice(0, ENROL.maxWindows);
  return {
    ok: true,
    speechSec,
    pieces: keep.length,
    consistency,
    centroid: pack(centroid),
    windows: windows.map(pack),
    warn: consistency < 0.5 ? 'The recording sounded uneven (background noise or more than one voice?). Re-record in a quiet place for better matching.' : '',
  };
}

export function newId() {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Applies an enrolment to the stored list: adds a person, or re-records an existing one (same id).
export function upsertPerson(list, { id, name, lang, print }) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) throw new Error('Give the person a name first.');
  const taken = list.find((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase());
  if (taken) throw new Error(`There is already a voice called ${taken.name}.`);
  const rec = { id: id || newId(), name: clean, lang: lang || 'en', centroid: print.centroid, windows: print.windows, secs: Math.round(print.speechSec), created: Date.now() };
  const i = list.findIndex((p) => p.id === rec.id);
  if (i < 0) return [...list, rec];
  const next = [...list];
  next[i] = { ...next[i], ...rec, created: next[i].created, updated: Date.now() };
  return next;
}

// A second recording in another language is added to the same person: the average is recomputed and the
// individual samples from both are kept, so a person speaking English or Malayalam is matched either way.
export function addRecording(list, id, { lang, print }) {
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw new Error('That person no longer exists.');
  const p = list[i];
  const c = mean([unpack(p.centroid), unpack(print.centroid)]);
  const windows = [...(p.windows || []), ...print.windows].slice(-ENROL.maxWindows * 2);
  const langs = [...new Set([...(p.langs || [p.lang || 'en']), lang])];
  const next = [...list];
  next[i] = { ...p, centroid: pack(c), windows, langs, secs: (p.secs || 0) + Math.round(print.speechSec), updated: Date.now() };
  return next;
}

export { SR };
