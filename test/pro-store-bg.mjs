// The service worker writing through the meeting store: captions merged in the last chunk as before, presence held in
// memory and written every 15 s (and read back after a restart), counts for the pill without reading the transcript, and
// the offscreen document's store calls.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
const { send, state, listeners } = await import('./bg-harness.mjs');
const { getMeeting } = await import('../src/store.js');
const MS = await import('../src/meetingstore.js');

let passed = 0;
async function test(name, fn) {
  try {
    state.mem.local = {};
    state.mem.session = {};
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split("\n").slice(0, 25).join('\n     ')}`);
    process.exitCode = 1;
  }
}
const OWN = { id: 'testid', url: 'chrome-extension://testid/popup.html' };
const OFFSCREEN = { id: 'testid', url: 'chrome-extension://testid/offscreen.html' };
const MEET = { id: 'testid', tab: { id: 7 }, url: 'https://meet.google.com/abc-defg-hij' };
const json = (v) => JSON.parse(JSON.stringify(v));
const live = (id = 'mt') => {
  state.mem.session.rec = { recording: true, meetingId: id, tabId: 7, startedAt: Date.now() - 5000, mic: true, micOn: true, micWanted: true, meetMuted: null };
  state.mem.local[`meeting:${id}`] = { id, title: 'T', startedAt: Date.now() - 5000, endedAt: null, segments: [], errors: [], mom: '' };
  state.mem.local.meetingIds = [id];
  state.mem.local.settings = { myName: 'Asha' };
};
// Every key read, to prove what was not read.
const reads = [];
const realGet = globalThis.chrome.storage.local.get;
globalThis.chrome.storage.local.get = async (keys) => (reads.push(...[].concat(keys ?? [])), realGet(keys));

// The caption merging as it was when the whole list was rewritten each time (background.js before 1.4), for comparison.
function reference(caps, captions, who) {
  for (const c of captions) {
    const name = who(c.name);
    let last = null;
    for (let i = caps.length - 1; i >= 0 && i > caps.length - 40; i--) if (caps[i].name === name) {
      last = caps[i];
      break;
    }
    if (last && c.t - last.t2 < 15 && (c.text.startsWith(last.text) || last.text.startsWith(c.text) || last.text.slice(0, 20) === c.text.slice(0, 20))) {
      last.text = c.text.length >= last.text.length ? c.text : last.text;
      last.t2 = c.t;
    } else caps.push({ t: c.t, t2: c.t, name, text: c.text });
  }
  if (caps.length > 4000) caps.splice(0, caps.length - 4000);
}
const who = (n) => (/^you$/i.test(n) ? 'Asha' : n);
const SCRIPT = [
  [{ name: 'Amal', text: 'So the', t: 10 }],
  [{ name: 'Amal', text: 'So the plan is', t: 11 }],
  [{ name: 'Amal', text: 'So the plan is to ship', t: 12 }, { name: 'You', text: 'Yes', t: 12 }],
  [{ name: 'You', text: 'Yes, Friday', t: 13 }, { name: 'Amal', text: 'So the plan is to ship on Friday.', t: 13 }],
  [{ name: 'Amal', text: 'So the plan is to ship', t: 14 }], // Meet showed a shorter version again: the longer one stays
  [{ name: 'Priya', text: 'What about the district offices and the training?', t: 20 }],
  [{ name: 'Priya', text: 'What about the district offices, and who trains them?', t: 22 }], // same first 20 characters
  [{ name: 'Amal', text: 'So the plan is to ship on Friday. Then', t: 40 }], // more than 15 s later: a new line
  [{ name: 'You', text: 'Okay', t: 41 }],
  [{ name: 'Priya', text: 'Different sentence altogether', t: 42 }],
];

await test('captions: a scripted call gives exactly the lines the old whole-list merge gave', async () => {
  live();
  const ref = [];
  for (const captions of SCRIPT) {
    await send({ type: 'meet-snap', t: captions[0].t, names: [], captions }, MEET);
    reference(ref, json(captions), who);
  }
  assert.deepEqual((await getMeeting('mt')).captions, ref);
  assert.equal(ref.length, 6);
});

await test('captions: merging works inside the last chunk; a line whose earlier version is in an older chunk grows where it is; 4000 is the cap', async () => {
  live();
  // 199 lines from others, then Amal starts speaking: his line is the 200th, the last of chunk 0
  const filler = Array.from({ length: 199 }, (_, i) => ({ name: `P${i % 5}`, text: `filler ${i}`, t: 100 + i * 20 }));
  for (let i = 0; i < filler.length; i += 50) await send({ type: 'meet-snap', t: 1, names: [], captions: filler.slice(i, i + 50) }, MEET);
  await send({ type: 'meet-snap', t: 1, names: [], captions: [{ name: 'Amal', text: 'One', t: 5000 }] }, MEET);
  await send({ type: 'meet-snap', t: 1, names: [], captions: [{ name: 'Amal', text: 'One two', t: 5001 }] }, MEET);
  let caps = (await getMeeting('mt')).captions;
  assert.equal(caps.length, 200);
  assert.equal(caps.at(-1).text, 'One two', 'merged within the last chunk');
  await send({ type: 'meet-snap', t: 1, names: [], captions: [{ name: 'Ravi', text: 'Hi', t: 5002 }] }, MEET); // opens chunk 1
  await send({ type: 'meet-snap', t: 1, names: [], captions: [{ name: 'Ravi', text: 'Hi all', t: 5003 }, { name: 'Amal', text: 'One two three', t: 5003 }] }, MEET);
  caps = (await getMeeting('mt')).captions;
  assert.deepEqual(caps.slice(-2).map((c) => c.text), ['One two three', 'Hi all'], 'Ravi merged in chunk 1; Amal\'s line in chunk 0 grew there');
  assert.deepEqual(Object.keys(state.mem.local).filter((k) => k.startsWith('mp:mt:captions:')).sort(), ['mp:mt:captions:0', 'mp:mt:captions:1']);
  // the cap: older chunks go, whole
  for (let i = 0; i < 4200; i += 200) await send({ type: 'meet-snap', t: 1, names: [], captions: Array.from({ length: 200 }, (_, k) => ({ name: `Q${k}`, text: `line ${i + k}`, t: 10000 + (i + k) * 20 })) }, MEET);
  caps = (await getMeeting('mt')).captions;
  assert.ok(caps.length >= 4000 && caps.length < 4200, String(caps.length));
  assert.equal(caps.at(-1).text, 'line 4199');
});

await test('presence: written at once for a new meeting, then at most every 15 s, and in full when the recording stops', async () => {
  live();
  const ref = {};
  const snap = async (t, names) => {
    await send({ type: 'meet-snap', t, names, captions: [] }, MEET);
    for (const n of names) {
      const k = who(n);
      if (ref[k]) {
        ref[k][1] = t;
        ref[k][2]++;
      } else ref[k] = [t, t, 1];
    }
  };
  await snap(5, ['Amal', 'You']);
  assert.deepEqual(state.mem.local['meeting:mt'].presence, { Amal: [5, 5, 1], Asha: [5, 5, 1] }, 'the first sighting is written right away');
  reads.length = 0;
  await snap(6, ['Amal', 'Priya']);
  await snap(7, ['Amal']);
  assert.deepEqual(state.mem.local['meeting:mt'].presence, { Amal: [5, 5, 1], Asha: [5, 5, 1] }, 'held in memory, not written every second');
  assert.ok(!reads.includes('meeting:mt'), 'and not read again either');
  await send({ type: 'stop' }, OWN);
  const m = await getMeeting('mt');
  assert.deepEqual(m.presence, ref);
  assert.deepEqual(m.presence.Amal, [5, 7, 3]);
  assert.ok(m.endedAt);
});

await test('presence: after a service-worker restart it is read back from the meeting; at most the unwritten window is lost', async () => {
  live();
  await send({ type: 'meet-snap', t: 5, names: ['Amal', 'Priya'], captions: [] }, MEET); // written
  await send({ type: 'meet-snap', t: 6, names: ['Ravi'], captions: [] }, MEET); // held in memory only
  // the worker is stopped and started again: a fresh copy of background.js with nothing in memory
  listeners.message.length = 0;
  await import('../src/background.js?restart=1');
  await send({ type: 'meet-snap', t: 30, names: ['Amal'], captions: [] }, MEET);
  await send({ type: 'stop' }, OWN);
  const p = (await getMeeting('mt')).presence;
  assert.deepEqual(p.Amal, [5, 30, 2], 'first seen before the restart is kept');
  assert.deepEqual(p.Priya, [5, 5, 1]);
  assert.equal(p.Ravi, undefined, 'the sighting inside the last unwritten window is the only loss');
});

await test('voice pieces: appended in chunks, capped at 12000, the model name written once; the pill counts without reading the transcript', async () => {
  live();
  const e = 'Q'.repeat(350);
  for (let i = 0; i < 12400; i += 200) await send({ type: 'voice-seg', meetingId: 'mt', segs: Array.from({ length: 200 }, (_, k) => ({ t0: i + k, t1: i + k + 1, e })) }, OFFSCREEN);
  const m = await getMeeting('mt');
  assert.ok(m.voiceSegs.length >= 12000 && m.voiceSegs.length < 12400, String(m.voiceSegs.length));
  assert.equal(m.voiceSegs.at(-1).t0, 12399);
  assert.equal(m.voiceModel, 'wespeaker-resnet34-lm');
  for (let i = 0; i < 450; i++) await send({ type: 'segment', meetingId: 'mt', seg: { t: i, src: 'others', text: `line ${i}` } }, OFFSCREEN);
  await send({ type: 'stt-error', meetingId: 'mt', error: 'HTTP 500' }, OFFSCREEN);
  reads.length = 0;
  const r = await send({ type: 'pill-state' }, MEET);
  assert.deepEqual(r.counts, { segs: 450, errs: 1 });
  assert.ok(!reads.some((k) => /^mp:mt:(segments:[01]|voiceSegs)/.test(k)), `read ${reads.join(', ')}`);
});

await test('the offscreen document\'s store calls: a stale copy saved by message keeps lines appended meanwhile, and recovered audio is appended once', async () => {
  live();
  for (let i = 0; i < 3; i++) await send({ type: 'segment', meetingId: 'mt', seg: { t: i, src: 'others', text: `line ${i}` } }, OFFSCREEN);
  // the job runner's store, wired the way offscreen.js wires it: every call is a message (so a JSON copy)
  const viaBg = async (m) => {
    const r = json(await send(json({ type: 'store', ...m }), OFFSCREEN));
    if (!r?.ok) throw new Error('store call failed');
    return r.value;
  };
  const jobs = await import('../src/jobs.js');
  jobs.useStore({ getMeeting: (id) => viaBg({ op: 'getMeeting', id }), saveMeeting: (meeting) => viaBg({ op: 'saveMeeting', meeting }), patchMeeting: (id, fields) => viaBg({ op: 'patchMeeting', id, fields }) });
  const { savePending, listPending } = await import('../src/audiostore.js');
  await savePending({ meetingId: 'mt', src: 'others', t: 50, wav: new Blob([new Uint8Array(44 + 32000)]) });
  const copy = await viaBg({ op: 'getMeeting', id: 'mt' }); // read before the recorder adds more
  await send({ type: 'segment', meetingId: 'mt', seg: { t: 3, src: 'others', text: 'line 3' } }, OFFSCREEN);
  const meeting = MS.stampLoaded(copy);
  const r = await jobs.retryPendingAudio({ id: 'mt', meeting, settings: {}, transcribeFn: async () => 'recovered words' });
  assert.equal(r.done, 1);
  assert.equal((await listPending('mt')).length, 0);
  let m = await getMeeting('mt');
  assert.deepEqual(m.segments.map((s) => s.text), ['line 0', 'line 1', 'line 2', 'line 3', 'recovered words']);
  // the runner's copy (which now also holds the recovered line) saved by message: nothing doubled, nothing dropped
  meeting.title = 'Renamed by the job';
  await viaBg({ op: 'saveMeeting', meeting: MS.withWireStamps(meeting) });
  m = await getMeeting('mt');
  assert.deepEqual(m.segments.map((s) => s.text), ['line 0', 'line 1', 'line 2', 'line 3', 'recovered words']);
  assert.equal(m.title, 'Renamed by the job');
  const meta = await viaBg({ op: 'patchMeeting', id: 'mt', fields: { job: { state: 'writing', beat: 1 } } });
  assert.equal(meta.job.state, 'writing');
  assert.equal(meta.segments, undefined, 'the patch answers with META only');
});

console.log(`\n${passed} passed`);
process.exit(process.exitCode || 0);
