// Meeting records in chrome.storage.local, split so that a long meeting costs the same to write to as a short one.
//
//   meeting:{id}          META: everything small (title, times, minutes, job, presence, attendees...) plus
//                         parts: { [list]: { first, chunks, size } }, which says where each long list is kept.
//   mp:{id}:{list}:{n}    one CHUNK of a long list: an array of up to `size` items, n = first .. first + chunks - 1.
//
// Every chunk except the last one (the tail) is full, so a list's length is (chunks - 1) * size + tail length and an
// append only rewrites the tail chunk. META is written only when a chunk is opened or dropped, or a small field changes.
// Before 1.4 a meeting was one record with the lists inline; such a record is read as it is and is moved into chunks by
// the first append, patch or save that touches it (there is no migration pass over all meetings).
//
// Copies handed out by getMeeting carry hidden marks of what each list held when it was read, so saveMeeting writes a
// list only when the caller changed it, and never overwrites lines added in the meantime by someone else (see saveMeeting).

export const LISTS = ['segments', 'captions', 'voiceSegs', 'debug', 'errors', 'gaps', 'silences', 'screens'];
export const CHUNK = 200;
const SIZE = { voiceSegs: 400 }; // fingerprints are written in batches of up to 200 every 10 s
// Longest a list may grow while recording: older items are dropped a whole chunk at a time (silences: newer ones are not added).
export const CAPS = { voiceSegs: 12000, captions: 4000, silences: 400 };

const mkey = (id) => `meeting:${id}`;
const ckey = (id, list, n) => `mp:${id}:${list}:${n}`;
const isList = (k) => LISTS.includes(k);
const sizeOf = (list) => SIZE[list] || CHUNK;
const local = () => chrome.storage.local;

// chrome.storage cannot hold typed arrays ("Cannot serialize value to JSON"). Everything written goes through plain():
// typed arrays become ordinary arrays.
export function plain(v) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : x)));
}

// ---- marks of what a copy held when it was read ----
// A hidden (symbol) property on each list array and on the record. Symbols are not copied by JSON or messages, so a copy that
// travelled through chrome.runtime messages gets its marks back with stampLoaded() and sends them along as `__loaded`.
const STAMP = Symbol.for('debrief.loaded');
const PRESENT = Symbol.for('debrief.lists');
const WIRE = '__loaded';
// What each small (META) field held when read: { field: fingerprint }. An enumerable symbol, so it rides along with
// { ...m } and Object.assign like the list marks do (those sit on the shared arrays), and is still dropped by JSON and messages.
const META = Symbol.for('debrief.meta');
const META_WIRE = '@meta'; // its name inside `__loaded` (never a list name)
const NOT_META = new Set(['id', 'parts', 'counts', WIRE]);

// Length plus a 32-bit FNV-1a hash of the JSON text: any change to any item (an edited word, a removed line) changes it.
export function hashList(arr) {
  const s = JSON.stringify(arr || []);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(arr || []).length}:${s.length}:${(h >>> 0).toString(36)}`;
}

const hide = (o, k, value) => Object.defineProperty(o, k, { value, enumerable: false, configurable: true, writable: true });

// Length plus FNV-1a of one field's JSON: enough to tell "this copy changed it" from "this copy only read it".
function fingerprint(v) {
  const s = JSON.stringify(v) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
const metaKeys = (m) => Object.keys(m).filter((k) => !isList(k) && !NOT_META.has(k) && m[k] !== undefined);
const metaMarks = (m) => Object.fromEntries(metaKeys(m).map((k) => [k, fingerprint(m[k])]));

// Marks every list of `m` with what it holds now. Used on every copy getMeeting returns, and on copies that arrived by message.
export function stampLoaded(m) {
  if (!m || typeof m !== 'object') return m;
  const present = new Set();
  for (const l of LISTS) {
    if (!Array.isArray(m[l])) continue;
    present.add(l);
    hide(m[l], STAMP, { n: m[l].length, h: hashList(m[l]) });
  }
  hide(m, PRESENT, present);
  if (WIRE in m) delete m[WIRE];
  m[META] = metaMarks(m);
  return m;
}

// The marks as a plain field, for a copy about to be sent by message to saveMeeting elsewhere.
export function withWireStamps(m) {
  if (!m || typeof m !== 'object') return m;
  const marks = {};
  for (const l of LISTS) if (Array.isArray(m[l]) && m[l][STAMP]) marks[l] = m[l][STAMP];
  if (m[META]) marks[META_WIRE] = m[META];
  return m[PRESENT] || m[META] ? { ...m, [WIRE]: marks } : { ...m };
}

const wireStamp = (s) => (s && Number.isInteger(s.n) && typeof s.h === 'string' ? s : null);

// ---- one meeting at a time ----
// Operations on one meeting run one after the other, so two appends never read the same tail and a save never writes back
// a chunk count that another write has just raised. The service worker, the offscreen document and the pages are separate
// contexts sharing one storage: Web Locks (granted in the order asked) cover them all. Where there are none (tests), a
// queue inside this context does the same for it. No operation here takes the lock twice, so it cannot wait on itself.
const queues = new Map();
function locked(id, fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(`debrief-meeting:${id}`, fn);
  const p = (queues.get(id) || Promise.resolve()).then(fn);
  const tail = p.catch(() => {});
  queues.set(id, tail);
  tail.then(() => queues.get(id) === tail && queues.delete(id));
  return p;
}

// ---- a write: collects every key to set and remove, then commits with one set (and one remove) ----
function keysOf(id, list, p) {
  const out = [];
  for (let i = 0; p && i < p.chunks; i++) out.push(ckey(id, list, p.first + i));
  return out;
}

// Reads META for writing. A record in the old shape has its inline lists moved into chunks here (written on commit).
async function begin(id) {
  const k = mkey(id);
  const stored = (await local().get(k))[k];
  if (!stored) return null;
  const tx = { id, meta: { ...stored, parts: plain(stored.parts || {}) }, set: {}, drop: new Set(), metaDirty: false, chunks: {} };
  for (const l of LISTS) {
    if (!(l in tx.meta)) continue;
    const inline = tx.meta[l];
    delete tx.meta[l];
    tx.metaDirty = true;
    // inline next to chunks cannot be made by this module; if it ever happens the chunks are the list
    if (Array.isArray(inline) && !tx.meta.parts[l]) writeList(tx, l, inline);
  }
  return tx;
}

function fresh(id) {
  return { id, meta: { id, parts: {} }, set: {}, drop: new Set(), metaDirty: true, chunks: {}, isNew: true };
}

async function readChunk(tx, key) {
  if (key in tx.set) return tx.set[key];
  if (!(key in tx.chunks)) tx.chunks[key] = (await local().get(key))[key] || [];
  return tx.chunks[key];
}

async function readList(tx, list) {
  const p = tx.meta.parts[list];
  const keys = keysOf(tx.id, list, p).filter((k) => !(k in tx.set) && !(k in tx.chunks));
  if (keys.length) Object.assign(tx.chunks, { ...Object.fromEntries(keys.map((k) => [k, []])), ...(await local().get(keys)) });
  const out = [];
  for (const k of keysOf(tx.id, list, p)) out.push(...(k in tx.set ? tx.set[k] : tx.chunks[k]));
  return out;
}

// The whole list is rewritten from chunk 0; chunk keys no longer used are removed.
function writeList(tx, list, items) {
  const old = tx.meta.parts[list];
  const size = sizeOf(list);
  const p = { first: 0, chunks: 0, size };
  for (let i = 0; i < items.length; i += size) tx.set[ckey(tx.id, list, p.chunks++)] = items.slice(i, i + size);
  for (const k of keysOf(tx.id, list, old)) if (!(k in tx.set)) tx.drop.add(k);
  tx.meta.parts[list] = p;
  tx.metaDirty = true;
}

function removeList(tx, list) {
  for (const k of keysOf(tx.id, list, tx.meta.parts[list])) tx.drop.add(k);
  delete tx.meta.parts[list];
  tx.metaDirty = true;
}

// Hands the tail chunk (a copy) to fn, which may change its items or push new ones; fn returns false for "nothing changed".
// A tail that grew past the chunk size is split into new chunks. Only the tail (and META, if a chunk was opened) is written.
async function editTail(tx, list, fn) {
  let p = tx.meta.parts[list];
  if (!p) {
    p = tx.meta.parts[list] = { first: 0, chunks: 0, size: sizeOf(list) };
    tx.metaDirty = true;
  }
  const at = p.first + Math.max(0, p.chunks - 1);
  const tail = p.chunks ? [...(await readChunk(tx, ckey(tx.id, list, at)))] : [];
  if (fn(tail) === false || (!p.chunks && !tail.length)) return;
  const pieces = [];
  for (let i = 0; i < tail.length; i += p.size) pieces.push(tail.slice(i, i + p.size));
  if (!pieces.length) pieces.push([]);
  pieces.forEach((piece, j) => (tx.set[ckey(tx.id, list, at + j)] = piece));
  const chunks = Math.max(0, p.chunks - 1) + pieces.length;
  if (chunks !== p.chunks) {
    p.chunks = chunks;
    tx.metaDirty = true;
  }
}

async function countOf(tx, list) {
  const p = tx.meta.parts[list];
  if (!p?.chunks) return 0;
  return (p.chunks - 1) * p.size + (await readChunk(tx, ckey(tx.id, list, p.first + p.chunks - 1))).length;
}

// Drops the oldest whole chunks while what is left still holds at least `max` items.
async function trimTx(tx, list, max) {
  const p = tx.meta.parts[list];
  if (!p || !(max >= 0)) return;
  let n = await countOf(tx, list);
  while (p.chunks > 1 && n - p.size >= max) {
    tx.drop.add(ckey(tx.id, list, p.first));
    p.first++;
    p.chunks--;
    n -= p.size;
    tx.metaDirty = true;
  }
}

async function commit(tx) {
  if (tx.metaDirty) tx.set[mkey(tx.id)] = tx.meta;
  if (Object.keys(tx.set).length) await local().set(plain(tx.set));
  const drop = [...tx.drop].filter((k) => !(k in tx.set));
  if (drop.length) await local().remove(drop);
}

// Fields given to patchMeeting / saveMeeting: lists are routed to their chunks, everything else is META.
function applyField(tx, k, v) {
  if (k === 'parts' || k === 'counts' || k === WIRE) return;
  if (isList(k)) {
    if (Array.isArray(v)) writeList(tx, k, v);
    else if (v == null) removeList(tx, k);
    return;
  }
  if (v === undefined) delete tx.meta[k];
  else tx.meta[k] = v;
  tx.metaDirty = true;
}

// ---- reading ----
function metaOnly(stored) {
  const out = {};
  for (const [k, v] of Object.entries(stored)) if (!isList(k) && k !== 'parts') out[k] = v;
  return out;
}

const tailKey = (id, list, p) => (p?.chunks ? ckey(id, list, p.first + p.chunks - 1) : null);

// Full records from META rows: one storage call for every chunk of every row.
async function assemble(rows, { stamp = true } = {}) {
  const keys = [];
  for (const r of rows) for (const [l, p] of Object.entries(r.parts || {})) if (isList(l)) keys.push(...keysOf(r.id, l, p));
  const got = keys.length ? await local().get(keys) : {};
  return rows.map((r) => {
    const m = metaOnly(r);
    for (const l of LISTS) {
      const p = r.parts?.[l];
      if (p) m[l] = keysOf(r.id, l, p).flatMap((k) => got[k] || []);
      else if (Array.isArray(r[l])) m[l] = r[l]; // the old shape: still inline
    }
    m.segments ||= [];
    m.errors ||= [];
    return stamp ? stampLoaded(m) : m;
  });
}

export async function getMeeting(id) {
  const k = mkey(id);
  const stored = (await local().get(k))[k];
  return stored ? (await assemble([stored]))[0] : null;
}

// META rows with counts of the lists named in `counts` (only their tail chunks are read: one call for all rows).
async function withCounts(rows, counts) {
  const want = counts || [];
  const keys = [];
  for (const r of rows) for (const l of want) if (r.parts?.[l]) keys.push(tailKey(r.id, l, r.parts[l]));
  const got = keys.filter(Boolean).length ? await local().get(keys.filter(Boolean)) : {};
  return rows.map((r) => {
    const m = metaOnly(r);
    m.counts = {};
    for (const l of want) {
      const p = r.parts?.[l];
      m.counts[l] = p ? (p.chunks ? (p.chunks - 1) * p.size + (got[tailKey(r.id, l, p)] || []).length : 0) : Array.isArray(r[l]) ? r[l].length : 0;
    }
    return m;
  });
}

// META only (no transcript), with counts: { segments, errors, ... } for the lists asked for (all by default; [] for none).
export async function getMeetingMeta(id, { counts = LISTS } = {}) {
  const k = mkey(id);
  const stored = (await local().get(k))[k];
  return stored ? (await withCounts([stored], counts))[0] : null;
}

async function storedRows(ids) {
  const r = ids.length ? await local().get(ids.map(mkey)) : {};
  return ids.map((id) => r[mkey(id)]).filter(Boolean);
}
const newestFirst = (a, b) => (b.startedAt || 0) - (a.startedAt || 0);
const allIds = async () => (await local().get('meetingIds')).meetingIds || [];

// Every meeting in full (Ask needs the transcripts). Lists that only show meetings use listMeetingMetas.
// These copies are for reading: they carry no marks (working them out costs time on every meeting), so to change a
// meeting read it with getMeeting first; an unmarked copy given to saveMeeting would have its lists written whole.
export async function listMeetings() {
  return (await assemble(await storedRows(await allIds()), { stamp: false })).sort(newestFirst);
}

// META of every meeting (or of `ids`), newest first, with counts as in getMeetingMeta.
export async function listMeetingMetas({ counts = LISTS, ids } = {}) {
  return (await withCounts(await storedRows(ids || (await allIds())), counts)).sort(newestFirst);
}

export async function addMeetingId(id) {
  const meetingIds = await allIds();
  await local().set({ meetingIds: [id, ...meetingIds] });
}

// ---- writing ----
function checkList(list) {
  if (!isList(list)) throw new Error(`Not a meeting list: ${list}`);
}

// Appends items to a list. Options: max = keep at least this many and drop the oldest whole chunks beyond it;
// limit = never hold more than this many (newer items are not added). Returns false when the meeting does not exist.
export function appendMeeting(id, list, items, { max, limit } = {}) {
  checkList(list);
  return locked(id, async () => {
    const tx = await begin(id);
    if (!tx) return false;
    let add = Array.isArray(items) ? items : [items];
    if (limit >= 0) add = add.slice(0, Math.max(0, limit - (await countOf(tx, list))));
    if (add.length) await editTail(tx, list, (tail) => void tail.push(...add));
    if (max >= 0) await trimTx(tx, list, max);
    await commit(tx);
    return true;
  });
}

// Lets fn change the last chunk of a list in place (captions: a caption that grows replaces its earlier, shorter version).
// fn(tail) may edit items and push new ones, and returns false when it changed nothing. max as in appendMeeting.
// look = n: fn sees at least the last n items. A tail chunk that was just opened holds few, so fn would not find the
// caption it should extend (it is in the chunk before) and would add it again: then the last items of the previous chunk
// come first in what fn gets, and an edit to them is written back there.
export function editMeetingTail(id, list, fn, { max, look = 0 } = {}) {
  checkList(list);
  return locked(id, async () => {
    const tx = await begin(id);
    if (!tx) return false;
    const p = tx.meta.parts[list];
    let lead = null;
    if (p?.chunks > 1) {
      const tail = await readChunk(tx, ckey(id, list, p.first + p.chunks - 1));
      const k = Math.max(0, look - tail.length);
      if (k) {
        const key = ckey(id, list, p.first + p.chunks - 2);
        const prev = await readChunk(tx, key);
        const items = plain(prev.slice(Math.max(0, prev.length - k)));
        lead = { key, prev, items, was: JSON.stringify(items) };
      }
    }
    if (!lead) await editTail(tx, list, fn);
    else
      await editTail(tx, list, (tail) => {
        const all = [...lead.items, ...tail];
        const r = fn(all);
        const n = lead.items.length;
        tail.splice(0, tail.length, ...all.slice(n));
        const now = all.slice(0, n);
        if (JSON.stringify(now) !== lead.was) tx.set[lead.key] = [...lead.prev.slice(0, lead.prev.length - n), ...now];
        return r;
      });
    if (max >= 0) await trimTx(tx, list, max);
    if (lead && tx.drop.has(lead.key)) delete tx.set[lead.key]; // trimmed away: not written back
    await commit(tx);
    return true;
  });
}

export function replaceMeetingList(id, list, items) {
  checkList(list);
  return locked(id, async () => {
    const tx = await begin(id);
    if (!tx) return false;
    writeList(tx, list, items || []);
    await commit(tx);
    return true;
  });
}

export function trimMeetingList(id, list, max) {
  checkList(list);
  return locked(id, async () => {
    const tx = await begin(id);
    if (!tx) return false;
    await trimTx(tx, list, max);
    await commit(tx);
    return true;
  });
}

// Changes only the given fields. Small fields touch META only (no list chunk is read or written); a list given here
// replaces that list. Returns the META (without lists), or null when the meeting does not exist.
export function patchMeeting(id, fields = {}) {
  return locked(id, async () => {
    const tx = await begin(id);
    if (!tx) return null;
    for (const [k, v] of Object.entries(fields)) if (k !== 'id') applyField(tx, k, v);
    await commit(tx);
    return metaOnly(tx.meta);
  });
}

// Read-modify-write of META only: fn(meta) changes small fields (pauses, end time, job). A list set by fn is routed as in patchMeeting.
export function updateMeetingMeta(id, fn) {
  return locked(id, async () => {
    const tx = await begin(id);
    if (!tx) return null;
    const meta = plain(metaOnly(tx.meta)); // a copy: fn may change nested values (a pause's end) in place
    fn(meta);
    for (const l of LISTS) if (l in meta) applyField(tx, l, meta[l]);
    tx.meta = { ...metaOnly(meta), id, parts: tx.meta.parts };
    tx.metaDirty = true;
    await commit(tx);
    return metaOnly(tx.meta);
  });
}

// Saves a whole record. META: a copy read with getMeeting (marked) writes only the small fields it changed, over what is
// stored now; an unmarked copy (a new record, a backup) is written as it is. Each list is written only if this copy changed it:
//  - not marked (a new record, or an array the caller built): it is written as it is;
//  - unchanged since it was read: left alone, even if it grew in storage meanwhile (a page saving an old copy
//    must not drop lines the recorder appended after the page read it);
//  - only added to since it was read (items pushed at the end): just the new items are appended after what is stored now,
//    leaving out any that storage already holds after what the copy read (they were appended there too);
//  - changed in any other way (an edited line, a removed line): the caller's copy wins.
// A list missing from the record is removed only if the copy had it when it was read (it was deleted on purpose).
export function saveMeeting(m) {
  return locked(m.id, async () => {
    const tx = (await begin(m.id)) || fresh(m.id);
    const wire = m[WIRE] && typeof m[WIRE] === 'object' ? m[WIRE] : null;
    const present = m[PRESENT] || (wire ? new Set(Object.keys(wire).filter(isList)) : null);
    const metaMark = m[META] || (wire?.[META_WIRE] && typeof wire[META_WIRE] === 'object' ? wire[META_WIRE] : null);
    for (const l of LISTS) {
      const c = m[l];
      if (c == null) {
        if (present?.has(l) && tx.meta.parts[l]) removeList(tx, l);
        continue;
      }
      if (!Array.isArray(c)) continue;
      const s = c[STAMP] || wireStamp(wire?.[l]);
      if (!s || tx.isNew) {
        // tx.isNew: the meeting is not in storage (deleted while this copy was open): the copy is all there is
        writeList(tx, l, c);
        continue;
      }
      const h = hashList(c);
      if (h === s.h) continue;
      if (c.length > s.n && hashList(c.slice(0, s.n)) === s.h) {
        let add = c.slice(s.n);
        const stored = await readList(tx, l);
        if (hashList(stored) !== s.h) {
          // Someone else added to the list too. A new item of this copy that storage already holds after what the copy read
          // (the same line was appended there and pushed here, or the copy was refreshed from storage) is not added again.
          const there = new Map();
          for (const x of stored.slice(s.n)) there.set(JSON.stringify(x), (there.get(JSON.stringify(x)) || 0) + 1);
          add = add.filter((x) => {
            const k = JSON.stringify(x);
            if (!there.get(k)) return true;
            there.set(k, there.get(k) - 1);
            return false;
          });
        }
        if (add.length) await editTail(tx, l, (tail) => void tail.push(...add));
      } else writeList(tx, l, c);
    }
    const parts = tx.meta.parts;
    if (!metaMark || tx.isNew) {
      tx.meta = { ...metaOnly(m), id: m.id, parts };
      delete tx.meta[WIRE];
      delete tx.meta.counts;
      tx.metaDirty = true;
    } else {
      // Only the fields this copy changed since it was read (added, changed or removed) go onto the META stored now:
      // a page's old copy saving a title must not take back the minutes, items or emailedAt the job wrote meanwhile.
      const mine = metaOnly(m);
      for (const k of metaKeys(mine)) if (metaMark[k] !== fingerprint(mine[k])) applyField(tx, k, mine[k]);
      for (const k of Object.keys(metaMark)) if (!isList(k) && !NOT_META.has(k) && mine[k] === undefined && k in tx.meta) applyField(tx, k, undefined);
    }
    await commit(tx);
    // the copy now matches storage for what it wrote: mark it again, so saving it twice does not append twice
    stampLoaded(m);
  });
}

// Removes META and every chunk of a meeting (also chunks left over from an interrupted write, where getKeys exists).
export function removeMeetingRecords(id) {
  return locked(id, async () => {
    const k = mkey(id);
    const stored = (await local().get(k))[k];
    const keys = new Set([k]);
    for (const [l, p] of Object.entries(stored?.parts || {})) for (const x of keysOf(id, l, p)) keys.add(x);
    if (typeof local().getKeys === 'function') {
      const prefix = `mp:${id}:`;
      for (const x of await local().getKeys().catch(() => [])) if (x.startsWith(prefix)) keys.add(x);
    }
    await local().remove([...keys]);
  });
}

// Strips the voice fingerprints (and the model name) from every meeting, in either shape. Only META rows are read; the
// fingerprint chunks are removed without being read. Each meeting under its lock, so a write landing meanwhile (the job's
// minutes, a heartbeat) is not overwritten with the META read before it. Returns how many meetings changed.
export async function stripVoicesFromAll() {
  let changed = 0;
  for (const id of await allIds()) {
    const did = await locked(id, async () => {
      const k = mkey(id);
      const r = (await local().get(k))[k];
      if (!r || !(r.voiceSegs || r.voiceModel || r.parts?.voiceSegs)) return false;
      const { voiceSegs: _v, voiceModel: _m, ...rest } = r;
      const drop = [];
      if (r.parts?.voiceSegs) {
        drop.push(...keysOf(id, 'voiceSegs', r.parts.voiceSegs));
        rest.parts = { ...r.parts };
        delete rest.parts.voiceSegs;
      }
      await local().set({ [k]: rest });
      if (drop.length) await local().remove(drop);
      return true;
    });
    if (did) changed++;
  }
  return changed;
}
