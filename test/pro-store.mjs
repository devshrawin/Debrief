// The meeting store (src/meetingstore.js) and backups (src/backup.js): a meeting is META plus chunked lists, so writing to a
// long meeting costs what writing to a short one does, and no transcript line is ever lost or written twice.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

// chrome.storage.local in memory, counting what is read and written (bytes = JSON length per key).
const mem = {};
const io = { written: {}, reads: [] };
const json = (v) => JSON.parse(JSON.stringify(v));
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(mem) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        io.reads.push(list);
        return Object.fromEntries(list.filter((k) => k in mem).map((k) => [k, json(mem[k])]));
      },
      set: async (o) => {
        for (const [k, v] of Object.entries(o)) {
          const text = JSON.stringify(v);
          io.written[k] = (io.written[k] || 0) + text.length;
          mem[k] = JSON.parse(text);
        }
      },
      remove: async (k) => [].concat(k).forEach((x) => delete mem[x]),
      getKeys: async () => Object.keys(mem),
    },
  },
};
const S = await import('../src/store.js');
const MS = await import('../src/meetingstore.js');
const B = await import('../src/backup.js');
const { getMeeting, getMeetingMeta, saveMeeting, patchMeeting, appendMeeting, editMeetingTail, replaceMeetingList, trimMeetingList, listMeetings, listMeetingMetas, addMeetingId, deleteMeeting, forgetAllVoices, updateMeetingMeta } = S;

let passed = 0;
async function test(name, fn) {
  try {
    for (const k of Object.keys(mem)) delete mem[k];
    resetIo();
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 5).join('\n     ')}`);
    process.exitCode = 1;
  }
}
function resetIo() {
  io.written = {};
  io.reads = [];
}
const bytes = () => Object.values(io.written).reduce((a, b) => a + b, 0);
const chunkKeys = (id, list) => Object.keys(mem).filter((k) => k.startsWith(`mp:${id}:${list ? `${list}:` : ''}`));
const seg = (i) => ({ t: i * 7, src: i % 3 ? 'others' : 'me', c: i * 7, dur: 6.5, text: `Line ${i}: we went over the rollout plan for the district offices and agreed on the dates.` });
const fp = (i) => ({ t0: i * 0.5, t1: i * 0.5 + 0.5, e: `${String(i).padStart(6, '0')}${'Q'.repeat(344)}` }); // a packed fingerprint is about 350 characters
const cap = (i) => ({ t: i, t2: i + 2, name: `Person ${i % 6}`, text: `Caption ${i} with a few words that Meet showed on screen.` });
const newMeeting = async (id, extra = {}) => {
  await saveMeeting({ id, title: 'Sync', url: 'https://meet.google.com/abc-defg-hij', startedAt: 1_700_000_000_000, endedAt: null, segments: [], errors: [], mom: '', stt: 'gemini', ...extra });
  await addMeetingId(id);
};
const legacy = (id, extra = {}) => {
  mem[`meeting:${id}`] = { id, title: 'Old', startedAt: 1_600_000_000_000, endedAt: 1_600_000_600_000, segments: Array.from({ length: 450 }, (_, i) => seg(i)), errors: ['e1'], captions: Array.from({ length: 30 }, (_, i) => cap(i)), voiceSegs: Array.from({ length: 10 }, (_, i) => fp(i)), voiceModel: 'x', debug: ['d1', 'd2'], mom: '# Old', presence: { Amal: [1, 50, 9] }, ...extra };
  mem.meetingIds = [...(mem.meetingIds || []), id];
};

await test('lists are read back whole and in order across chunk boundaries, from one storage call for all chunks', async () => {
  await newMeeting('m1');
  let i = 0;
  for (const n of [1, 7, 199, 200, 1, 43]) await appendMeeting('m1', 'segments', Array.from({ length: n }, () => seg(i++)));
  resetIo();
  const m = await getMeeting('m1');
  assert.deepEqual(m.segments, Array.from({ length: i }, (_, k) => seg(k)));
  assert.equal(chunkKeys('m1', 'segments').length, Math.ceil(i / MS.CHUNK));
  assert.equal(io.reads.length, 2, 'META, then every chunk in one call');
  assert.ok(Array.isArray(m.errors) && !('parts' in m));
  assert.equal(mem['meeting:m1'].segments, undefined, 'no list is kept inside META');
});

const results = {};
await test('appending to a long meeting writes no more than appending to a short one (one chunk, META untouched)', async () => {
  await newMeeting('m1');
  const per = [];
  for (let i = 0; i < 2010; i++) {
    resetIo();
    await appendMeeting('m1', 'segments', [seg(i)]);
    per.push({ bytes: bytes(), keys: Object.keys(io.written) });
  }
  const tenth = per[9];
  const late = per[2009]; // the 10th line of its chunk, like the 10th line of the meeting
  results.append10 = tenth.bytes;
  results.append2000 = per[1999].bytes;
  results.append2010 = late.bytes;
  results.maxAppend = Math.max(...per.map((p) => p.bytes));
  // the same 10 lines, only with longer numbers in them ("Line 2009", t: 14063)
  assert.ok(late.bytes <= tenth.bytes * 1.1, `${late.bytes} vs ${tenth.bytes}`);
  assert.deepEqual(late.keys, ['mp:m1:segments:10'], 'only the tail chunk is written');
  const fullChunk = JSON.stringify(Array.from({ length: MS.CHUNK }, (_, k) => seg(k + 1800))).length;
  for (const p of per) assert.ok(p.bytes <= fullChunk + 2000, 'never more than one chunk (plus a small META when a chunk opens)');
  assert.equal(per.filter((p) => p.keys.includes('meeting:m1')).length, Math.ceil(2010 / MS.CHUNK), 'META is written only when a chunk opens (the first one included)');
  // what the old single-record store wrote for the same append: the whole meeting
  results.oldAppend2000 = JSON.stringify({ ...mem['meeting:m1'], parts: undefined, segments: (await getMeeting('m1')).segments.slice(0, 2000) }).length;
  const m = await getMeeting('m1');
  assert.equal(m.segments.length, 2010);
  assert.deepEqual(m.segments.at(-1), seg(2009));
});

await test('a heartbeat on a two-hour meeting writes only META, reads no list, and META stays small', async () => {
  await newMeeting('big', { presence: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`Person number ${i}`, [i, 7000 - i, 400]])), attendees: Array.from({ length: 15 }, (_, i) => `Person number ${i}`), invited: Array.from({ length: 15 }, (_, i) => ({ email: `p${i}@example.com`, name: `Person number ${i}`, status: 'yes' })), pauses: [{ from: 100, to: 200 }], room: false });
  for (let i = 0; i < 2000; i += 100) await appendMeeting('big', 'segments', Array.from({ length: 100 }, (_, k) => seg(i + k)));
  for (let i = 0; i < 4000; i += 200) await appendMeeting('big', 'captions', Array.from({ length: 200 }, (_, k) => cap(i + k)), { max: MS.CAPS.captions });
  for (let i = 0; i < 12000; i += 200) await appendMeeting('big', 'voiceSegs', Array.from({ length: 200 }, (_, k) => fp(i + k)), { max: MS.CAPS.voiceSegs });
  await appendMeeting('big', 'debug', Array.from({ length: 300 }, (_, i) => `note ${i}: Meet mic muted at +${i}s; Debrief mic off`));
  resetIo();
  await patchMeeting('big', { job: { state: 'writing', beat: Date.now(), status: 'Writing the minutes…' } });
  assert.deepEqual(Object.keys(io.written), ['meeting:big']);
  assert.deepEqual(io.reads, [['meeting:big']], 'no chunk is read');
  results.meta = io.written['meeting:big'];
  assert.ok(results.meta < 50 * 1024, `META is ${results.meta} bytes`);
  const m = await getMeeting('big');
  results.oldRecord = JSON.stringify(m).length;
  assert.equal(m.segments.length, 2000);
  assert.equal(m.captions.length, 4000);
  assert.equal(m.voiceSegs.length, 12000);
  assert.equal(m.job.state, 'writing');
  const meta = await getMeetingMeta('big');
  assert.deepEqual(meta.counts, { segments: 2000, captions: 4000, voiceSegs: 12000, debug: 300, errors: 0, gaps: 0, silences: 0, screens: 0 });
  assert.equal(meta.segments, undefined);
});

await test('an old single-record meeting reads as it is, and the first append moves it into chunks with nothing lost or doubled', async () => {
  legacy('old');
  const before = await getMeeting('old');
  assert.equal(before.segments.length, 450);
  assert.deepEqual(before.segments[449], seg(449));
  assert.deepEqual((await getMeetingMeta('old')).counts.segments, 450);
  await appendMeeting('old', 'segments', [seg(450)]);
  const meta = mem['meeting:old'];
  for (const l of MS.LISTS) assert.equal(meta[l], undefined, `${l} moved out of META`);
  assert.equal(meta.parts.segments.chunks, 3);
  const after = await getMeeting('old');
  assert.deepEqual(after.segments, Array.from({ length: 451 }, (_, i) => seg(i)));
  assert.deepEqual(after.captions, before.captions);
  assert.deepEqual(after.voiceSegs, before.voiceSegs);
  assert.deepEqual(after.debug, ['d1', 'd2']);
  assert.deepEqual(after.errors, ['e1']);
  assert.equal(after.mom, '# Old');
  assert.deepEqual(after.presence, { Amal: [1, 50, 9] });
  // a patch on an old record migrates it too, and keeps everything
  legacy('old2');
  await patchMeeting('old2', { title: 'Renamed' });
  assert.equal(mem['meeting:old2'].segments, undefined);
  const o2 = await getMeeting('old2');
  assert.equal(o2.segments.length, 450);
  assert.equal(o2.title, 'Renamed');
});

await test('a page saving the copy it read earlier does not drop lines appended meanwhile', async () => {
  await newMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(0), seg(1)]);
  const page = await getMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(2), seg(3), seg(4)]);
  await appendMeeting('m1', 'captions', [cap(1)]); // a list the page did not have at all
  page.title = 'Renamed on the page';
  await saveMeeting(page);
  const m = await getMeeting('m1');
  assert.equal(m.title, 'Renamed on the page');
  assert.deepEqual(m.segments, [0, 1, 2, 3, 4].map(seg));
  assert.deepEqual(m.captions, [cap(1)]);
  // the same through a message (the offscreen document): the marks travel as __loaded
  const remote = json(MS.withWireStamps(await getMeeting('m1')));
  await appendMeeting('m1', 'segments', [seg(5)]);
  remote.mom = '# Minutes';
  await saveMeeting(remote);
  const r = await getMeeting('m1');
  assert.deepEqual(r.segments, [0, 1, 2, 3, 4, 5].map(seg));
  assert.equal(r.mom, '# Minutes');
  assert.equal(mem['meeting:m1'].__loaded, undefined);
  // a spread copy keeps its arrays, so it is just as safe
  const spread = { ...(await getMeeting('m1')), title: 'Spread' };
  await appendMeeting('m1', 'segments', [seg(6)]);
  await saveMeeting(spread);
  assert.equal((await getMeeting('m1')).segments.length, 7);
});

await test('a caller that pushed lines onto its copy is saved, once, and merged after lines appended by someone else', async () => {
  await newMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(0), seg(1)]);
  const a = await getMeeting('m1');
  a.segments.push(seg(100));
  await saveMeeting(a);
  assert.deepEqual((await getMeeting('m1')).segments, [seg(0), seg(1), seg(100)]);
  await saveMeeting(a); // saving twice adds nothing
  assert.deepEqual((await getMeeting('m1')).segments, [seg(0), seg(1), seg(100)]);
  // both sides added lines: the recorder's stay, the caller's come after them
  const b = await getMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(2)]);
  b.segments.push(seg(101));
  await saveMeeting(b);
  assert.deepEqual((await getMeeting('m1')).segments, [seg(0), seg(1), seg(100), seg(2), seg(101)]);
  // a copy refreshed from storage (Object.assign(meeting, latest)) and pushed onto: no line twice
  const c = await getMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(3)]);
  Object.assign(c, await getMeeting('m1'));
  await saveMeeting(c);
  assert.equal((await getMeeting('m1')).segments.length, 6);
  // the job's retry path: appended to storage and pushed onto its own copy; saving that copy later adds nothing
  const job = await getMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(4)]);
  job.segments.push(seg(4));
  await saveMeeting(job);
  assert.deepEqual((await getMeeting('m1')).segments.map((s) => s.t), [0, 7, 700, 14, 707, 21, 28]);
  // the same, but the copy was read before the recorder added a line: the recovered line is still there only once
  const stale = await getMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(5)]);
  await appendMeeting('m1', 'segments', [seg(200)]); // the retry's line, appended to storage...
  stale.segments.push(seg(200)); // ...and pushed onto the job's own copy
  await saveMeeting(stale);
  assert.deepEqual((await getMeeting('m1')).segments.map((s) => s.t), [0, 7, 700, 14, 707, 21, 28, 35, 1400]);
});

await test('an edited or shortened list from the caller wins; a list removed on purpose is removed', async () => {
  await newMeeting('m1');
  await appendMeeting('m1', 'segments', [seg(0), seg(1), seg(2)]);
  await appendMeeting('m1', 'voiceSegs', [fp(0)]);
  const a = await getMeeting('m1');
  a.segments[1].text = 'Fixed name';
  await saveMeeting(a);
  assert.equal((await getMeeting('m1')).segments[1].text, 'Fixed name');
  const b = await getMeeting('m1');
  b.segments.pop();
  delete b.voiceSegs;
  await saveMeeting(b);
  const m = await getMeeting('m1');
  assert.equal(m.segments.length, 2);
  assert.equal(m.voiceSegs, undefined);
  assert.equal(chunkKeys('m1', 'voiceSegs').length, 0);
  // a brand-new record (no marks) is written as it is
  await saveMeeting({ id: 'm2', title: 'x', segments: [seg(9)], errors: [], debug: ['a'] });
  assert.deepEqual((await getMeeting('m2')).segments, [seg(9)]);
  assert.deepEqual((await getMeeting('m2')).debug, ['a']);
});

await test('replace and trim remove the chunk keys they no longer use', async () => {
  await newMeeting('m1');
  await appendMeeting('m1', 'segments', Array.from({ length: 450 }, (_, i) => seg(i)));
  assert.equal(chunkKeys('m1', 'segments').length, 3);
  await replaceMeetingList('m1', 'segments', [seg(7)]);
  assert.deepEqual(chunkKeys('m1', 'segments'), ['mp:m1:segments:0']);
  assert.deepEqual((await getMeeting('m1')).segments, [seg(7)]);
  await patchMeeting('m1', { segments: [seg(8), seg(9)], title: 'P' }); // a list given to patchMeeting replaces it
  assert.deepEqual((await getMeeting('m1')).segments, [seg(8), seg(9)]);
  await appendMeeting('m1', 'captions', Array.from({ length: 1000 }, (_, i) => cap(i)));
  await trimMeetingList('m1', 'captions', 450);
  const caps = (await getMeeting('m1')).captions;
  assert.equal(caps.length, 600, 'whole chunks: at least 450 kept');
  assert.deepEqual(caps[0], cap(400));
  assert.deepEqual(chunkKeys('m1', 'captions').sort(), ['mp:m1:captions:2', 'mp:m1:captions:3', 'mp:m1:captions:4']);
  assert.equal(await patchMeeting('nope', { title: 'x' }), null);
  assert.equal(await appendMeeting('nope', 'segments', [seg(1)]), false);
  assert.equal(mem['meeting:nope'], undefined, 'nothing is created for a missing meeting');
});

await test('deleting a meeting leaves no META, no chunk and no id behind', async () => {
  await newMeeting('m1');
  await newMeeting('m2');
  await appendMeeting('m1', 'segments', Array.from({ length: 450 }, (_, i) => seg(i)));
  await appendMeeting('m1', 'voiceSegs', [fp(1)]);
  mem['mp:m1:segments:99'] = [seg(1)]; // left over from an interrupted write
  await deleteMeeting('m1');
  assert.deepEqual(Object.keys(mem).filter((k) => k.includes('m1')), []);
  assert.deepEqual(mem.meetingIds, ['m2']);
  assert.ok(mem['meeting:m2']);
});

await test('voice fingerprints stop at 12000 a whole chunk at a time, oldest first; silences stop at 400', async () => {
  await newMeeting('m1');
  for (let i = 0; i < 13000; i += 200) await appendMeeting('m1', 'voiceSegs', Array.from({ length: 200 }, (_, k) => fp(i + k)), { max: MS.CAPS.voiceSegs });
  const v = (await getMeeting('m1')).voiceSegs;
  assert.ok(v.length >= 12000 && v.length < 12000 + 400, String(v.length));
  assert.deepEqual(v.at(-1), fp(12999), 'the newest is kept');
  assert.deepEqual(v[0], fp(13000 - v.length), 'only the oldest went, in order');
  assert.equal(chunkKeys('m1', 'voiceSegs').length, Math.ceil(v.length / 400));
  for (let i = 0; i < 405; i++) await appendMeeting('m1', 'silences', [{ t: i, dur: 1 }], { limit: MS.CAPS.silences });
  const s = (await getMeeting('m1')).silences;
  assert.equal(s.length, 400);
  assert.deepEqual(s.at(-1), { t: 399, dur: 1 });
});

await test('forgetting all voices strips fingerprints from both shapes without reading transcripts', async () => {
  legacy('old');
  await newMeeting('new', { voiceModel: 'w' });
  await appendMeeting('new', 'voiceSegs', Array.from({ length: 900 }, (_, i) => fp(i)));
  await appendMeeting('new', 'segments', [seg(1)]);
  mem.voices = [{ id: 'v1', name: 'A' }];
  resetIo();
  assert.equal(await forgetAllVoices(), 2);
  assert.ok(!io.reads.flat().some((k) => k.startsWith('mp:')), 'no chunk was read');
  for (const id of ['old', 'new']) {
    const m = await getMeeting(id);
    assert.equal(m.voiceSegs, undefined);
    assert.equal(m.voiceModel, undefined);
    assert.ok(m.segments.length > 0, 'the transcript stays');
  }
  assert.equal(chunkKeys('new', 'voiceSegs').length, 0);
  assert.equal(mem.voices, undefined);
});

await test('many appends at once keep their order; META edits keep nested changes', async () => {
  await newMeeting('m1');
  await Promise.all(Array.from({ length: 450 }, (_, i) => appendMeeting('m1', 'segments', [seg(i)])));
  assert.deepEqual((await getMeeting('m1')).segments, Array.from({ length: 450 }, (_, i) => seg(i)));
  await updateMeetingMeta('m1', (m) => (m.pauses ||= []).push({ from: 1, to: null }));
  await updateMeetingMeta('m1', (m) => (m.pauses.at(-1).to = 5));
  assert.deepEqual((await getMeeting('m1')).pauses, [{ from: 1, to: 5 }]);
  assert.equal((await getMeeting('m1')).segments.length, 450);
});

await test('list views read META and tail chunks only', async () => {
  legacy('old');
  await newMeeting('m1');
  await appendMeeting('m1', 'segments', Array.from({ length: 450 }, (_, i) => seg(i)));
  resetIo();
  const rows = await listMeetingMetas({ counts: ['segments'] });
  assert.deepEqual(rows.map((r) => [r.id, r.counts.segments]), [['m1', 450], ['old', 450]]);
  assert.ok(!io.reads.flat().some((k) => /^mp:m1:segments:[01]$/.test(k)), 'full chunks are not read');
  const all = await listMeetings();
  assert.equal(all.find((m) => m.id === 'm1').segments.length, 450);
  const caps = [];
  // editMeetingTail: change the last item in place
  await appendMeeting('m1', 'captions', [cap(1)]);
  await editMeetingTail('m1', 'captions', (t) => void (t.at(-1).text = 'grown'));
  caps.push(...(await getMeeting('m1')).captions);
  assert.deepEqual(caps.map((c) => c.text), ['grown']);
  assert.equal(await editMeetingTail('m1', 'captions', () => false), true);
});

await test('with Web Locks (extension pages, the service worker, the offscreen document) every operation takes the meeting\'s lock', async () => {
  const names = [];
  let tail = Promise.resolve();
  const fake = { request: (name, fn) => (names.push(name), (tail = tail.then(() => fn()))) }; // granted in the order asked, like the real one
  Object.defineProperty(globalThis.navigator, 'locks', { value: fake, configurable: true });
  try {
    await newMeeting('m1');
    await Promise.all(Array.from({ length: 300 }, (_, i) => appendMeeting('m1', 'segments', [seg(i)])));
    await patchMeeting('m1', { title: 'Locked' });
    assert.deepEqual((await getMeeting('m1')).segments, Array.from({ length: 300 }, (_, i) => seg(i)));
    assert.ok(names.length >= 302 && names.every((n) => n === 'debrief-meeting:m1' || n === 'debrief-meeting:\0meetingIds'));
  } finally {
    delete globalThis.navigator.locks;
  }
});

// ---- backups ----
const KEYS = { geminiKey: 'G-SECRET', geminiBackups: ['G2-SECRET'], sarvamKey: 'S-SECRET', deepgramKey: 'D-SECRET', anthropicKey: 'A-SECRET', oaKey: 'O-SECRET', sttKey: 'T-SECRET', emailSecret: 'E-SECRET', emailWebhook: 'https://script.google.com/macros/s/SECRET/exec', webhookUrl: 'https://hooks.example.com/SECRET' };
const seedAll = async () => {
  mem.schema = S.SCHEMA;
  mem.settings = { myName: 'Asha', momLanguage: 'Hindi', ...KEYS };
  mem.voices = [{ id: 'v1', name: 'Amal', centroid: 'xyz' }];
  mem.voiceBlock = [{ name: 'X', centroid: 'c' }];
  mem.emailNames = { 'a@x.com': 'Amal' };
  mem.learned = { names: { Amal: 3 }, pending: [], rejected: [] };
  mem.uiTheme = 'dark';
  await newMeeting('m1700000000001', { title: 'One', startedAt: 1_700_000_000_001, mom: '# One' });
  await appendMeeting('m1700000000001', 'segments', Array.from({ length: 450 }, (_, i) => seg(i)));
  await appendMeeting('m1700000000001', 'voiceSegs', [fp(1), fp(2)]);
  legacy('m1600000000000');
};

await test('every key-like setting is listed as secret, and a backup leaves them out unless asked', async () => {
  for (const k of Object.keys(S.DEFAULTS)) if (/key|secret|webhook|backups/i.test(k)) assert.ok(B.SECRET_SETTINGS.includes(k), `${k} must be in SECRET_SETTINGS`);
  await seedAll();
  const out = await B.exportAll();
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
  assert.equal(out.settings.myName, 'Asha');
  assert.equal(out.app, 'debrief');
  assert.equal(out.meetings.length, 2);
  assert.ok(out.notes.some((n) => /audio/i.test(n)));
  const withKeys = await B.exportAll({ includeKeys: true });
  assert.equal(withKeys.settings.geminiKey, 'G-SECRET');
  const one = await B.exportMeeting('m1700000000001');
  assert.equal(one.meeting.voiceSegs, undefined);
  assert.equal(one.meeting.segments.length, 450);
  assert.equal((await B.exportMeeting('m1700000000001', { voiceSegs: true })).meeting.voiceSegs.length, 2);
});

await test('export, wipe, import gives back identical meetings and settings', async () => {
  await seedAll();
  const before = await listMeetings();
  const file = JSON.parse(JSON.stringify(await B.exportAll({ includeKeys: true })));
  for (const k of Object.keys(mem)) delete mem[k];
  const r = await B.importAll(file, { mode: 'replace', acceptRouting: ['apiKeys'] });
  assert.deepEqual(r.meetings, { added: 2, skipped: 0 });
  assert.equal(r.settingsApplied, true);
  assert.equal(r.voices, 1);
  // an import marks each meeting decided and gives it a finished job, so nothing runs or sends by itself after a restore (emailSkip); otherwise identical
  const after = JSON.parse(JSON.stringify(await listMeetings()));
  for (const m of after) {
    assert.equal(m.decided, true);
    assert.equal(m.emailSkip, true); // a restored meeting never mails by itself
    assert.ok(m.job?.state === 'done' || m.job?.state === 'failed');
    delete m.decided;
    delete m.emailSkip;
    delete m.job;
  }
  assert.deepEqual(after, JSON.parse(JSON.stringify(before)));
  assert.equal(mem.settings.geminiKey, 'G-SECRET');
  assert.equal(mem.settings.myName, 'Asha');
  assert.deepEqual(mem.emailNames, { 'a@x.com': 'Amal' });
  assert.equal(mem.uiTheme, 'dark');
  assert.deepEqual(mem.meetingIds, ['m1700000000001', 'm1600000000000']);
});

await test('merge skips meetings already here and keeps the keys set here; replace wipes the meetings first', async () => {
  await seedAll();
  const file = JSON.parse(JSON.stringify(await B.exportAll({ includeKeys: true })));
  file.settings.geminiKey = 'OTHER';
  file.settings.anthropicKey = '';
  file.settings.momLanguage = 'English';
  file.meetings.push({ ...file.meetings[0], id: 'm1800000000000', title: 'New one', startedAt: 1_800_000_000_000 });
  const r = await B.importAll(file);
  assert.deepEqual(r.meetings, { added: 1, skipped: 2 });
  assert.equal(mem.settings.geminiKey, 'G-SECRET', 'a key set here wins in a merge');
  assert.equal(mem.settings.anthropicKey, 'A-SECRET', 'never an empty value over a set one');
  assert.equal(mem.settings.momLanguage, 'Hindi', 'a setting chosen here wins in a merge');
  assert.equal(mem.meetingIds[0], 'm1800000000000');
  assert.equal((await getMeeting('m1800000000000')).segments.length, 450);
  // replace: only the file's meetings remain, and nothing of the old ones
  await newMeeting('m1900000000000');
  await appendMeeting('m1900000000000', 'segments', [seg(1)]);
  const r2 = await B.importAll({ app: 'debrief', version: 1, meetings: [file.meetings[2]] }, { mode: 'replace' });
  assert.deepEqual(r2.meetings, { added: 1, skipped: 0 });
  assert.deepEqual(mem.meetingIds, ['m1800000000000']);
  assert.equal(Object.keys(mem).filter((k) => /m1900000000000|m1700000000001|m1600000000000/.test(k)).length, 0);
  assert.equal(r2.settingsApplied, false);
});

await test('a hostile or broken file is refused or cleaned, and nothing is written for a refused one', async () => {
  await seedAll();
  const snapshot = JSON.stringify(mem);
  await assert.rejects(() => B.importAll({ app: 'other', version: 1 }), /not a Debrief backup/);
  await assert.rejects(() => B.importAll(null), /not a Debrief backup/);
  await assert.rejects(() => B.importAll({ app: 'debrief', version: 99 }), /newer version/);
  await assert.rejects(() => B.importAll({ app: 'debrief', version: 1, meetings: 'lots' }), /damaged/);
  await assert.rejects(() => B.importAll({ app: 'debrief', version: 1, meetings: Array.from({ length: 5001 }, () => ({})) }), /more than 5000/);
  await assert.rejects(() => B.importAll({ app: 'debrief', version: 1, meetings: [{ id: 'm1234567890', mom: 'x'.repeat(20 * 1024 * 1024 + 1) }] }, { mode: 'replace' }), /far too large/);
  assert.equal(JSON.stringify(mem), snapshot, 'a refused file changes nothing');
  const r = await B.importAll({
    app: 'debrief', version: 1, schema: 3, evil: { run: 'alert(1)' },
    settings: { myName: 42, momLanguage: 'Hindi', unknownSetting: 'x', autoStop: 'yes', geminiKey: '' },
    meetings: [
      { id: '../../etc', title: 'Bad id', startedAt: 1_750_000_000_000, segments: 'not a list', captions: [cap(1), 5, null], job: { state: 'writing', beat: 1 }, emailSending: 1, parts: { segments: { first: 0, chunks: 9, size: 200 } } },
      'not a meeting',
      { id: 'm1700000000001', title: 'Duplicate' },
    ],
    voices: [{ id: 'v9', name: 'Ravi' }, 'junk', { nothing: true }],
    emailNames: { 'a@x.com': 'Someone Else', 'b@x.com': 'Bina', 'c@x.com': 7 },
  });
  assert.deepEqual(r.meetings, { added: 1, skipped: 1 });
  assert.ok(r.warnings.length >= 3, JSON.stringify(r.warnings));
  assert.equal(mem.evil, undefined);
  const id = mem.meetingIds.find((x) => !['m1700000000001', 'm1600000000000'].includes(x));
  assert.match(id, /^m\d{13}$/);
  const m = await getMeeting(id);
  assert.deepEqual(m.segments, []);
  assert.deepEqual(m.captions, [cap(1)]);
  assert.equal(m.job.state, 'failed', 'an imported job is never resumed');
  assert.equal(m.emailSending, undefined);
  assert.equal(mem.settings.myName, 'Asha', 'a wrong type is ignored');
  assert.equal(mem.settings.autoStop, undefined);
  assert.equal(mem.settings.unknownSetting, undefined);
  assert.equal(mem.settings.geminiKey, 'G-SECRET');
  assert.equal(mem.settings.momLanguage, 'Hindi');
  assert.equal(r.voices, 1);
  assert.deepEqual(mem.emailNames, { 'a@x.com': 'Amal', 'b@x.com': 'Bina' }, 'a name known here is not flipped');
});

await test('old settings in a backup go through the same migration as stored ones', async () => {
  mem.schema = S.SCHEMA;
  const r = await B.importAll({ app: 'debrief', version: 1, schema: 1, settings: { meetingLanguage: 'hinglish', geminiKey2: 'K2', minutesFormat: 'amnex' } }, { mode: 'replace', acceptRouting: ['apiKeys'] });
  assert.equal(r.settingsApplied, true);
  assert.deepEqual(mem.settings.meetingLanguages, ['hi', 'en']);
  assert.deepEqual(mem.settings.geminiBackups, ['K2']);
  assert.equal(mem.settings.minutesFormat, 'template');
  assert.equal(mem.settings.meetingLanguage, undefined);
});

// ---- backups: a file can come from anyone (security review H1) ----
const VICTIM = { myName: 'Asha', momLanguage: 'Hindi', sttProvider: 'openai', sttKey: 'gsk_VICTIM', llmProvider: 'openai', oaKey: 'sk-VICTIM', oaModel: 'gpt-x', emailWebhook: 'https://script.google.com/macros/s/MINE/exec', emailSecret: 'E-MINE' };
const EVIL = () => ({
  app: 'debrief', version: 1, schema: 3, meetings: [],
  settings: {
    sttBase: 'https://evil.example/v1', oaBase: 'https://evil.example/v1', sttProvider: 'openai', llmProvider: 'openai', oaModel: 'evil-model', sttModel: 'evil-whisper',
    webhookUrl: 'https://evil.example/hook', emailWebhook: 'https://script.google.com/macros/s/EVIL/exec', emailTo: 'x@evil.example', emailAuto: true, emailTranscript: true,
    consentNotice: true, consentText: 'Join https://evil.example now', shareMode: 'auto', shareList: 'x@evil.example', shareGroups: 'all | x@evil.example', shareHow: 'bcc', shareDomains: true,
    shareExternalGuard: false, myOrgDomains: 'evil.example', calendarLookup: false, screenNotes: true, voiceModelUrl: 'https://evil.example/m.onnx',
    usdInr: 3, // not routing: fills a setting left at its default here
    momLanguage: 'English', // not routing: set here, so kept in a merge
  },
});
const routingSnapshot = () => Object.fromEntries(B.ROUTING_SETTINGS.map((k) => [k, mem.settings?.[k]]));

await test('backup H1: every setting that decides where data goes is a routing setting, with a plain label', () => {
  for (const k of ['sttBase', 'oaBase', 'llmProvider', 'sttProvider', 'oaModel', 'sttModel', 'webhookUrl', 'emailWebhook', 'emailTo', 'voiceModelUrl', 'shareMode', 'shareList', 'shareGroups', 'shareHow', 'shareDomains', 'shareExternalGuard', 'emailAuto', 'consentNotice', 'consentText', 'myOrgDomains', 'calendarLookup', 'emailTranscript', 'screenNotes'])
    assert.ok(B.ROUTING_SETTINGS.includes(k), `${k} must be a routing setting`);
  for (const k of B.ROUTING_SETTINGS) {
    assert.ok(k === 'apiKeys' || k in S.DEFAULTS, `${k} is a real setting`);
    assert.match(B.ROUTING_LABELS[k], /^[A-Z][a-z' ]/, `${k} has a label in words`);
  }
  for (const k of Object.keys(S.DEFAULTS)) if (/base|url|share|email|consent|domains|provider/i.test(k) && !/^email(Secret|Pdf|Word|Md)$/.test(k)) assert.ok(B.ROUTING_SETTINGS.includes(k), `${k} looks like routing: classify it`);
});

for (const mode of ['merge', 'replace']) {
  await test(`backup H1 (${mode}): a file never changes where data goes unless the person ticks it; keys here are never replaced or sent elsewhere`, async () => {
    mem.schema = S.SCHEMA;
    mem.settings = { ...VICTIM };
    const before = routingSnapshot();
    const r = await B.importAll(EVIL(), { mode });
    assert.deepEqual(routingSnapshot(), before, 'no routing setting changed');
    assert.deepEqual(r.routingApplied, []);
    assert.deepEqual(r.origins, []);
    assert.equal(mem.settings.sttKey, 'gsk_VICTIM');
    assert.equal(mem.settings.oaKey, 'sk-VICTIM');
    assert.equal(mem.settings.emailSecret, 'E-MINE');
    assert.equal(mem.settings.usdInr, 3, 'a default here is filled from the file');
    assert.equal(mem.settings.momLanguage, mode === 'merge' ? 'Hindi' : 'English', 'merge: what is set here wins; replace: the file');
    const s = await S.getSettings();
    assert.equal(s.sttBase, S.DEFAULTS.sttBase);
    assert.equal(s.consentNotice, false);
    assert.equal(s.shareExternalGuard, true);
    assert.equal(({}).polluted, undefined);
  });
}

await test('backup H1: keys and the relay secret are never imported over the ones here, in either mode', async () => {
  for (const mode of ['merge', 'replace']) {
    mem.schema = S.SCHEMA;
    mem.settings = { ...VICTIM, geminiKey: 'G-MINE' };
    await B.importAll({ app: 'debrief', version: 1, settings: { geminiKey: 'G-FILE', sttKey: 'T-FILE', oaKey: 'O-FILE', emailSecret: 'E-FILE' } }, { mode });
    assert.deepEqual([mem.settings.geminiKey, mem.settings.sttKey, mem.settings.oaKey, mem.settings.emailSecret], ['G-MINE', 'gsk_VICTIM', 'sk-VICTIM', 'E-MINE'], mode);
  }
  // nothing set here: the file's keys are taken (a restore on a new computer)
  for (const k of Object.keys(mem)) delete mem[k];
  mem.schema = S.SCHEMA;
  await B.importAll({ app: 'debrief', version: 1, settings: { geminiKey: 'G-FILE', sttKey: 'T-FILE', emailSecret: 'E-FILE' } }, { acceptRouting: ['apiKeys'] });
  assert.deepEqual([mem.settings.geminiKey, mem.settings.sttKey, mem.settings.emailSecret], ['G-FILE', 'T-FILE', 'E-FILE']);
});

await test('backup H1: a ticked server address is taken, its key here is cleared (never sent to the new server) unless the file brings one, and its origin is returned', async () => {
  mem.schema = S.SCHEMA;
  mem.settings = { ...VICTIM };
  const file = EVIL();
  file.settings.oaKey = 'sk-FILE'; // the file brings a key for its own minutes server
  const r = await B.importAll(file, { acceptRouting: ['sttBase', 'oaBase', 'emailWebhook', 'consentText', 'notASetting', 'apiKeys'] });
  assert.deepEqual(r.routingApplied.sort(), ['consentText', 'emailWebhook', 'oaBase', 'sttBase']);
  assert.equal(mem.settings.sttBase, 'https://evil.example/v1');
  assert.equal(mem.settings.sttKey, '', 'the key for the old speech server is not sent to the new one');
  assert.equal(mem.settings.oaKey, 'sk-FILE', "the file's own key goes with its address");
  assert.equal(mem.settings.emailSecret, '', 'a new relay never gets the secret of the old one');
  assert.equal(mem.settings.webhookUrl, undefined, 'not ticked: not taken');
  assert.equal(mem.settings.consentNotice, undefined);
  assert.ok(r.warnings.some((w) => /speech-to-text key was removed/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /relay secret was removed/.test(w)));
  assert.ok(!r.warnings.some((w) => /minutes model server .* key was removed/.test(w)));
  assert.deepEqual(r.origins, ['https://evil.example/*']);
});

await test('backup H1: a ticked address that is not safe (http to another computer, a password in it) is left out', async () => {
  mem.schema = S.SCHEMA;
  mem.settings = { ...VICTIM };
  const r = await B.importAll({ app: 'debrief', version: 1, settings: { sttBase: 'http://evil.example/v1', oaBase: 'https://u:p@evil.example/v1', webhookUrl: 'http://evil.example/h', voiceModelUrl: 'javascript:alert(1)' } }, { acceptRouting: ['sttBase', 'oaBase', 'webhookUrl', 'voiceModelUrl'] });
  assert.deepEqual(r.routingApplied, []);
  assert.equal(mem.settings.sttKey, 'gsk_VICTIM');
  assert.equal(r.warnings.filter((w) => /not a safe address/.test(w)).length, 4);
  const ok = await B.importAll({ app: 'debrief', version: 1, settings: { sttBase: 'http://localhost:8000/v1' } }, { acceptRouting: ['sttBase'] });
  assert.deepEqual(ok.routingApplied, ['sttBase'], 'http to this computer is fine');
});

await test('backup H1: previewImport lists what would change where data goes, in words, secrets hidden, and writes nothing', async () => {
  mem.schema = S.SCHEMA;
  mem.settings = { ...VICTIM, webhookUrl: 'https://hooks.example.com/TOKEN-MINE', consentText: S.DEFAULTS.consentText };
  const snap = JSON.stringify(mem);
  const file = EVIL();
  file.settings.llmProvider = 'openai'; // the same as here: not listed
  file.settings.shareList = ''; // empty: never written over a set value; here it is unset, so nothing changes either
  const p = await B.previewImport(file);
  assert.equal(JSON.stringify(mem), snap, 'nothing written');
  assert.equal(p.ok, true);
  assert.equal(p.hasSettings, true);
  assert.deepEqual([p.meetings, p.voices], [0, 0]);
  const by = Object.fromEntries(p.routing.map((x) => [x.key, x]));
  assert.ok(!by.llmProvider && !by.shareList && !by.sttProvider, 'only what differs');
  assert.deepEqual(by.sttBase, { key: 'sttBase', label: 'Speech-to-text server address', from: 'https://api.groq.com/openai/v1', to: 'https://evil.example/v1', origin: 'https://evil.example/*' });
  assert.equal(by.consentText.label, 'Notice posted in the meeting chat');
  assert.equal(by.consentNotice.from, 'off');
  assert.equal(by.consentNotice.to, 'on');
  assert.equal(by.shareMode.label, 'Who gets the minutes automatically');
  assert.equal(by.shareMode.to, 'me and the people listed');
  assert.equal(by.webhookUrl.from, 'https://hooks.example.com/… (rest hidden)');
  assert.ok(!JSON.stringify(p).includes('TOKEN-MINE') && !JSON.stringify(p).includes('MINE/exec'), 'secrets here are not shown');
  assert.equal(by.emailWebhook.label, 'Email relay address');
  assert.ok(!JSON.stringify(p).includes('VICTIM'));
  const bad = await B.previewImport({ app: 'debrief', version: 99 });
  assert.deepEqual([bad.ok, /newer version/.test(bad.error), bad.routing], [false, true, []]);
  assert.equal((await B.previewImport({ app: 'debrief', version: 1, meetings: [{}, {}], voices: [{ id: 'v' }] })).routing.length, 0);
});

await test('backup: replace never deletes the meeting being recorded now, and says so', async () => {
  await seedAll();
  chrome.storage.session = { get: async () => ({ rec: { recording: true, meetingId: 'm1700000000001', tabId: 3 } }), set: async () => {} };
  try {
    const r = await B.importAll({ app: 'debrief', version: 1, meetings: [{ id: 'm1800000000000', title: 'New', startedAt: 1_800_000_000_000, segments: [seg(1)] }, { id: 'm1700000000001', title: 'Same id as the recording', segments: [] }] }, { mode: 'replace' });
    assert.deepEqual(r.meetings, { added: 1, skipped: 1 });
    assert.equal((await getMeeting('m1700000000001')).segments.length, 450, 'the recording is untouched');
    assert.equal((await getMeeting('m1700000000001')).title, 'One');
    assert.equal(await getMeeting('m1600000000000'), null, 'the other old meeting is replaced');
    assert.deepEqual(mem.meetingIds, ['m1800000000000', 'm1700000000001']);
    assert.ok(r.warnings.some((w) => /being recorded now was kept/.test(w)));
  } finally {
    delete chrome.storage.session;
  }
});

await test('backup: an import cut off half way leaves every saved meeting listed, and replace has not deleted the old ones yet', async () => {
  for (const mode of ['merge', 'replace']) {
    for (const k of Object.keys(mem)) delete mem[k];
    await seedAll();
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = async (o) => {
      if (Object.keys(o).some((k) => k.includes('m1800000000002'))) throw new Error('tab closed');
      return realSet(o);
    };
    try {
      const meetings = [1, 2, 3].map((n) => ({ id: `m180000000000${n}`, title: `N${n}`, startedAt: 1_800_000_000_000 + n, segments: [seg(n)] }));
      await assert.rejects(() => B.importAll({ app: 'debrief', version: 1, meetings }, { mode }), /tab closed/);
    } finally {
      chrome.storage.local.set = realSet;
    }
    const stored = [...new Set(Object.keys(mem).filter((k) => k.startsWith('meeting:')).map((k) => k.slice(8).split(/[:#/]/)[0]))];
    for (const id of stored) assert.ok(mem.meetingIds.includes(id), `${mode}: ${id} is saved but not listed`);
    assert.ok(stored.includes('m1800000000001'));
    assert.ok((await getMeeting('m1700000000001'))?.segments.length === 450, `${mode}: the old meetings are still there`);
    assert.ok((await listMeetingMetas({ counts: [] })).some((m) => m.id === 'm1800000000001'), `${mode}: the saved one shows`);
  }
});

console.log(`\nmeasured: append #10 ${results.append10} B, #2000 ${results.append2000} B, #2010 ${results.append2010} B, largest append ${results.maxAppend} B; the old store wrote ${results.oldAppend2000} B for append #2000`);
console.log(`measured: heartbeat on a two-hour meeting writes META only, ${results.meta} B; the old store wrote the whole record, ${results.oldRecord} B`);
console.log(`\n${passed} passed`);
process.exit(process.exitCode || 0);
