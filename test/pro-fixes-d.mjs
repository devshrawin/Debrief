// Regressions from audit round 2 (data, jobs, minutes): A1 a Claude error event / a cut stream is not a finished reply,
// A2 the meeting list is changed under one lock, A3 ticks are read-modify-write, A4 an import never decides who gets mail,
// A5 email-once when the outcome is unknown, A6 "Incomplete" is not done, A7 no orphan record, A8 notes and attendees edited
// meanwhile survive the job, A9 the previous meeting that has actions, A10 a brace in prose before the JSON, A11 a pipe
// in a table cell, A12 "Dr Rahul", A13 replace-mode import stops the job of a meeting it deletes.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = process.env.SRC || new URL('../src', import.meta.url).pathname; // SRC=<dir>: run against another copy of src/ (to see a test fail before a fix)
const mem = {};
const json = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 2));
globalThis.chrome = {
  runtime: { sendMessage: async (m) => (sentMsgs.push(m), undefined) },
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(mem) : Array.isArray(keys) ? keys : [keys];
        const out = Object.fromEntries(list.filter((k) => k in mem).map((k) => [k, json(mem[k])]));
        await tick();
        return out;
      },
      set: async (o) => (await tick(), Object.assign(mem, json(o))),
      remove: async (k) => (await tick(), [].concat(k).forEach((x) => delete mem[x])),
    },
    session: { get: async () => ({}), set: async () => {} },
  },
};
const sentMsgs = [];
const reset = () => {
  for (const k of Object.keys(mem)) delete mem[k];
  sentMsgs.length = 0;
};

const MS = await import(`${SRC}/meetingstore.js`);
const S = await import(`${SRC}/store.js`);
const J = await import(`${SRC}/jobs.js`);
const A = await import(`${SRC}/actions.js`);
const ST = await import(`${SRC}/structured.js`);
const { generate } = await import(`${SRC}/llm.js`);
const { importAll } = await import(`${SRC}/backup.js`);
const realFetch = globalThis.fetch;

let passed = 0;
async function test(name, fn) {
  try {
    reset();
    J.useStore({ getMeeting: S.getMeeting, getMeetingMeta: S.getMeetingMeta, saveMeeting: S.saveMeeting, patchMeeting: S.patchMeeting, updateMeetingMeta: S.updateMeetingMeta, appendMeeting: S.appendMeeting, listMeetingMetas: S.listMeetingMetas, getSettings: S.getSettings, setActionStatus: undefined, applyReview: undefined, saveMinutes: undefined });
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 6).join('\n     ')}`);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------- A1 ----------------
const enc = new TextEncoder();
const sse = (evs) => new Response(new ReadableStream({ start(c) { for (const e of evs) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
const CLAUDE = { llmProvider: 'anthropic', anthropicModel: 'claude-3', anthropicKey: 'k' };
const start = { type: 'message_start', message: { usage: { input_tokens: 5 } } };
const delta = (text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

await test('A1: a Claude error event mid-stream throws a retryable error instead of returning half the text', async () => {
  globalThis.fetch = async () => sse([start, delta('# Minutes\n\n- half'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
  let err = null;
  try {
    await generate({ settings: CLAUDE, system: 's', user: 'u', onText() {} });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'it must throw');
  assert.equal(err.status, 529);
  const { isRetryable } = await import(`${SRC}/llm.js`);
  assert.ok(isRetryable(err));
});

await test('A1: a Claude stream that ends without message_stop is reported truncated; a whole one is not', async () => {
  let metas = [];
  globalThis.fetch = async () => sse([start, delta('abc')]);
  const r = await generate({ settings: CLAUDE, system: 's', user: 'u', onText() {}, onMeta: (m) => metas.push(m) });
  assert.equal(r, 'abc');
  assert.deepEqual(metas, [{ truncated: true }]);
  metas = [];
  globalThis.fetch = async () => sse([start, delta('abc'), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]);
  await generate({ settings: CLAUDE, system: 's', user: 'u', onText() {}, onMeta: (m) => metas.push(m) });
  assert.deepEqual(metas, []);
});

await test('A1: an OpenAI-compatible stream with no finish reason is truncated', async () => {
  const OA = { llmProvider: 'openai', oaBase: 'http://x/v1', oaModel: 'm' };
  const chunk = (content, finish) => ({ choices: [{ delta: { content }, finish_reason: finish || null }] });
  let metas = [];
  globalThis.fetch = async () => sse([chunk('hi')]);
  await generate({ settings: OA, system: 's', user: 'u', onText() {}, onMeta: (m) => metas.push(m) });
  assert.deepEqual(metas, [{ truncated: true }]);
  metas = [];
  globalThis.fetch = async () => sse([chunk('hi'), chunk('', 'stop')]);
  await generate({ settings: OA, system: 's', user: 'u', onText() {}, onMeta: (m) => metas.push(m) });
  assert.deepEqual(metas, []);
  metas = [];
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  await generate({ settings: OA, system: 's', user: 'u', onText() {}, onMeta: (m) => metas.push(m) });
  assert.deepEqual(metas, [], 'a server that ends with [DONE] and no finish reason sent a whole reply');
});

// ---------------- A2 ----------------
await test('A2: a delete racing a new recording does not drop the new id', async () => {
  mem.meetingIds = ['mA', 'mB'];
  await Promise.all([MS.addMeetingId('mNEW'), S.deleteMeeting('mA')]);
  assert.deepEqual([...mem.meetingIds].sort(), ['mB', 'mNEW']);
  mem.meetingIds = ['m1', 'm2', 'm3'];
  await Promise.all([S.deleteMeeting('m1'), MS.addMeetingId('m4'), S.deleteMeeting('m3'), MS.addMeetingId('m5')]);
  assert.deepEqual([...mem.meetingIds].sort(), ['m2', 'm4', 'm5']);
});

await test('A2: an import racing a new recording keeps the new id', async () => {
  mem.meetingIds = [];
  const file = { app: 'debrief', version: 1, meetings: [{ id: 'm1700000000001', title: 'Old', startedAt: 1, segments: [{ t: 1, text: 'x' }], errors: [], mom: '# x' }] };
  await Promise.all([importAll(file, { mode: 'merge' }), MS.addMeetingId('m1800000000000')]);
  assert.ok(mem.meetingIds.includes('m1800000000000'));
  assert.ok(mem.meetingIds.includes('m1700000000001'));
});

await test('A2: startInner lists the id before it saves the record', () => {
  const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const inner = src.slice(src.indexOf('async function startInner'));
  assert.ok(inner.indexOf('await addMeetingId(id)') >= 0 && inner.indexOf('await addMeetingId(id)') < inner.indexOf('await saveMeeting({'));
});

// ---------------- A3 ----------------
const ITEMS = () => ({ actions: [{ id: 'a1', text: 'one', status: 'open' }, { id: 'a2', text: 'two', status: 'open' }, { id: 'a3', text: 'three', status: 'open' }] });
await test('A3: two quick ticks both stick (setActionDone is one locked read-modify-write)', async () => {
  await S.saveMeeting({ id: 'm1', title: 'T', startedAt: 1, segments: [], errors: [], items: ITEMS() });
  const r = await Promise.all([J.setActionDone('m1', 'a1', true), J.setActionDone('m1', 'a2', true)]);
  assert.deepEqual(r, [true, true]);
  const m = await S.getMeeting('m1');
  assert.deepEqual(m.items.actions.map((a) => a.status), ['done', 'done', 'open']);
  assert.equal(await J.setActionDone('m1', 'nope', true), false);
  assert.equal(await J.setActionDone('gone', 'a1', true), false);
});

await test('A3: a tick during carry (applyReview) is not overwritten, through the offscreen store ops too', async () => {
  await S.saveMeeting({ id: 'm1', title: 'T', startedAt: 1, segments: [], errors: [], items: ITEMS() });
  // what the offscreen document gets: ops that run in the service worker under the meeting's lock
  const ops = {
    setActionStatus: (id, actionId, status) => S.updateMeetingMeta(id, (m) => { const n = A.tickItems(m.items, actionId, status === 'done'); if (n) m.items = n; }).then(() => true),
    applyReview: (id, done, by) => S.updateMeetingMeta(id, (m) => { const n = A.reviewItems(m.items, done, by); if (n) m.items = n; }),
  };
  assert.equal(typeof A.reviewItems, 'function');
  await Promise.all([ops.applyReview('m1', [{ id: 'a1', status: 'done' }], 'm9'), ops.setActionStatus('m1', 'a2', 'done')]);
  const m = await S.getMeeting('m1');
  assert.deepEqual(m.items.actions.map((a) => [a.status, a.doneBy]), [['done', 'm9'], ['done', undefined], ['open', undefined]]);
  // by message (no updateMeetingMeta): the store op is used
  const calls = [];
  J.useStore({ getMeeting: S.getMeeting, patchMeeting: S.patchMeeting, getMeetingMeta: S.getMeetingMeta, setActionStatus: async (...a) => (calls.push(a), true) });
  assert.equal(await J.setActionDone('m1', 'a3', true), true);
  assert.deepEqual(calls, [['m1', 'a3', 'done']]);
});

await test('A3: the service worker answers the setActionStatus and applyReview ops', () => {
  const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(src, /msg\.op === 'setActionStatus'/);
  assert.match(src, /msg\.op === 'applyReview'/);
  assert.match(readFileSync(new URL('../src/offscreen.js', import.meta.url), 'utf8'), /op: 'setActionStatus'[\s\S]*op: 'applyReview'/);
});

// ---------------- A4 / A13 ----------------
const backup = (meetings) => ({ app: 'debrief', version: 1, meetings });
await test('A4: an import drops the sharing and sending fields and starts no job', async () => {
  const base = { startedAt: 5, endedAt: 9, segments: [{ t: 1, text: 'hello' }], errors: [], shareTo: ['x@evil.com'], shareHeld: ['y@z.com'], shareStatus: 's', sharedTo: ['x@evil.com'], sharedAt: 1, transcriptShare: true, transcriptMine: true, emailedTo: 'a@b.c', emailedAt: 1, emailSending: 1, webhookAt: 1, webhookError: 'e' };
  await importAll(backup([{ ...base, id: 'm1700000000001', title: 'With', mom: '# minutes' }, { ...base, id: 'm1700000000002', title: 'Without', mom: '', job: { state: 'idle' } }, { ...base, id: 'm1700000000003', title: 'Running', mom: '', job: { state: 'writing', beat: Date.now() } }]), { mode: 'merge' });
  for (const id of ['m1700000000001', 'm1700000000002', 'm1700000000003']) {
    const m = await S.getMeeting(id);
    for (const k of ['shareTo', 'shareHeld', 'shareStatus', 'sharedTo', 'sharedAt', 'transcriptShare', 'transcriptMine', 'emailedTo', 'emailedAt', 'emailSending', 'webhookAt', 'webhookError']) assert.equal(m[k], undefined, `${id} ${k}`);
    assert.equal(m.decided, true, id);
  }
  assert.deepEqual((await S.getMeeting('m1700000000001')).job, { state: 'done' });
  for (const id of ['m1700000000002', 'm1700000000003']) {
    const j = (await S.getMeeting(id)).job;
    assert.equal(j.state, 'failed');
    assert.match(j.error, /press Write minutes/);
  }
});

await test('A13: replace-mode import stops the job of each meeting it deletes', async () => {
  await S.saveMeeting({ id: 'mOLD1', title: 'Old', startedAt: 1, segments: [], errors: [] });
  await S.saveMeeting({ id: 'mOLD2', title: 'Old2', startedAt: 2, segments: [], errors: [] });
  mem.meetingIds = ['mOLD1', 'mOLD2'];
  await importAll(backup([{ id: 'm1700000000009', title: 'New', startedAt: 3, segments: [], errors: [] }]), { mode: 'replace' });
  const aborted = sentMsgs.filter((m) => m.type === 'job-abort').map((m) => m.id).sort();
  assert.deepEqual(aborted, ['mOLD1', 'mOLD2']);
  assert.equal(mem['meeting:mOLD1'], undefined);
});

// ---------------- A5 ----------------
const MAIL = { emailWebhook: 'https://script.google.com/macros/s/x/exec', emailSecret: 's', emailTo: 'me@x.com' };
async function mailRun({ fetchImpl, patchFails = false }) {
  globalThis.fetch = fetchImpl;
  const state = { emailSending: null, emailedAt: null };
  const meeting = { id: 'mm', title: 'T', startedAt: 1700000000000, mom: '# Minutes\n\n- a', segments: [] };
  const patch = async (f) => {
    if (patchFails && 'emailedAt' in f) throw new Error('disk full');
    Object.assign(state, f);
    return state;
  };
  const r = await J.emailMinutes({ meeting, settings: { ...MAIL }, auto: true, patch, getLatest: async () => ({ ...state }), ctxFor: () => ({}) });
  return { r, state };
}
await test('A5: a relay timeout keeps emailSending (the mail may have gone out)', async () => {
  const { r, state } = await mailRun({ fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
  assert.equal(r.failed, true);
  assert.ok(state.emailSending, 'emailSending stays set');
  assert.match(r.status, /may already have been sent/);
});
await test('A5: a failure writing emailedAt after a good send keeps emailSending', async () => {
  const { state } = await mailRun({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, to: 'me@x.com' }) }), patchFails: true });
  assert.ok(state.emailSending);
});
await test('A5: a relay that answers ok:false clears emailSending (nothing went out)', async () => {
  const { r, state } = await mailRun({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'not allowed' }) }) });
  assert.equal(r.failed, true);
  assert.equal(state.emailSending, null);
});
await test('A5: a normal send still records emailedAt', async () => {
  const { r, state } = await mailRun({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, to: 'me@x.com' }) }) });
  assert.equal(r.sent, true);
  assert.ok(state.emailedAt);
  assert.equal(state.emailSending, null);
});

// ---------------- A6 / A9 ----------------
await test('A6: Incomplete, Unresolved, Partially done and pending are open, not done', () => {
  for (const s of ['Incomplete', 'Unresolved', 'Partially done', 'pending, to be completed', 'Not completed', 'In progress', 'unfinished']) assert.equal(A.normStatus(s), 'open', s);
  for (const s of ['Done', 'Completed', 'Resolved', 'Closed']) assert.equal(A.normStatus(s), 'done', s);
  assert.equal(A.normStatus('Not mentioned'), 'not mentioned');
});

await test('A9: the previous meeting is the newest one that has actions', () => {
  const D = 86400000;
  const cur = { id: 'c', title: 'Weekly sync', startedAt: 10 * D };
  const metas = [
    { id: 'old', title: 'Weekly sync', startedAt: 3 * D, items: { actions: [{ id: 'a', text: 'x', status: 'open' }] } },
    { id: 'empty', title: 'Weekly sync', startedAt: 7 * D, items: { actions: [] } },
    { id: 'none', title: 'Weekly sync', startedAt: 8 * D },
  ];
  assert.equal(A.previousInSeries(cur, metas).id, 'old');
  assert.equal(A.previousInSeries(cur, metas.slice(1)).id, 'none', 'none has actions: the newest is still the answer');
});

// ---------------- A7 ----------------
await test('A7: saving a copy of a deleted meeting writes nothing; a brand-new record is still written', async () => {
  await MS.saveMeeting({ id: 'm1700000000001', title: 'A', startedAt: 1, segments: [{ t: 1, text: 'x' }], errors: [] });
  await MS.addMeetingId('m1700000000001');
  const copy = await MS.getMeeting('m1700000000001');
  await MS.removeMeetingRecords('m1700000000001');
  copy.title = 'renamed';
  assert.equal(await MS.saveMeeting(copy), null);
  assert.equal('meeting:m1700000000001' in mem, false);
  assert.ok(!Object.keys(mem).some((k) => k.startsWith('mp:m1700000000001')));
  await MS.saveMeeting({ id: 'mNEW', title: 'N', startedAt: 1, segments: [], errors: [] });
  assert.ok('meeting:mNEW' in mem);
});

// ---------------- A8 ----------------
await test('A8: notes and attendees edited while the minutes were written are not overwritten', async () => {
  const id = 'm1';
  await S.saveMeeting({ id, title: 'T', startedAt: 1700000000000, endedAt: 1700000100000, segments: [{ t: 1, src: 'others', text: 'We agreed to ship on Friday.' }], errors: [], notes: 'old notes', attendees: ['Asha'], mom: '' });
  const meeting = await S.getMeeting(id);
  const settings = { llmProvider: 'openai', oaBase: 'http://x/v1', oaModel: 'm', minutesEngine: 'classic', minutesFormat: 'plain' };
  const fields = [];
  const patch = async (f) => (Object.assign(meeting, f), S.patchMeeting(id, f));
  await J.writeAndStore({
    id, meeting, settings, ui: { onStatus() {}, onText() {}, ready: async () => {} }, patch, cache: new Map(),
    generate: async () => {
      await S.patchMeeting(id, { notes: 'edited while writing', attendees: ['Asha', 'Ravi'] }); // the person edits during the model call
      return '# Minutes\n\n- We agreed to ship on Friday.';
    },
    io: { patchMeeting: S.patchMeeting, getMeeting: S.getMeeting, getMeetingMeta: S.getMeetingMeta, updateMeetingMeta: (i, fn) => S.updateMeetingMeta(i, (m) => (fields.push(Object.keys(m)), fn(m))) },
  });
  const m = await S.getMeeting(id);
  assert.match(m.mom, /ship on Friday/);
  assert.equal(m.notes, 'edited while writing');
  assert.deepEqual(m.attendees, ['Asha', 'Ravi']);
});

// ---------------- A10 / A11 / A12 ----------------
const good = { overview: 'o', summary: ['a'], topics: [], decisions: [{ text: 'd', at: '01:00' }], actions: [{ text: 'do x', owner: 'Rahul', due: 'Fri', at: '02:00', quote: '' }], risks: [], questions: [], next: [] };
await test('A10: a brace in prose before the JSON does not hide it', () => {
  const J1 = JSON.stringify(good);
  for (const t of [`Here is the {minutes} you asked for:\n${J1}`, `Note {x} and {"a": 1} first.\n\`\`\`json\n${J1}\n\`\`\``, J1, `{ oops\n${J1}`]) {
    const r = ST.parseStructuredReply(t);
    assert.ok(r.items, t.slice(0, 30));
    assert.equal(r.items.actions[0].text, 'do x');
  }
  assert.equal(ST.parseStructuredReply('no json here {x}').items, null);
});

await test('A11: a cell with a backslash and a pipe stays one cell and round-trips', () => {
  const md = ST.renderMinutes({ ...good, actions: [{ ...good.actions[0], text: 'a\\|b', owner: 'x' }, { ...good.actions[0], text: 'plain | pipe', owner: 'y' }] });
  const rows = md.split('\n').filter((l) => /^\| \d/.test(l));
  assert.equal(rows.length, 2);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (const r of rows) assert.equal(cells(r).length, cells(rows[0]).length, r);
  assert.equal(cells(rows[0]).length, 5, rows[0]);
  assert.ok(!rows[0].includes('\\\\|'), 'no doubled backslash');
});

await test('A12: "Dr Rahul" is kept when Rahul is in the transcript, any name token counts', () => {
  const tr = '[02:00] OTHERS: Rahul please do x by Friday\n[05:00] OTHERS: ok Sharma will review';
  const g = ST.guardStructured({ ...good, actions: [{ ...good.actions[0], owner: 'Dr Rahul' }, { ...good.actions[0], text: 'review', owner: 'Mr. Sharma', at: '05:00' }, { ...good.actions[0], text: 'z', owner: 'Prof Kumar Sharma', at: '05:00' }, { ...good.actions[0], text: 'y', owner: 'Dr Nobody', at: '02:00' }] }, { transcript: tr, attendees: [] });
  assert.deepEqual(g.actions.map((a) => a.owner), ['Dr Rahul', 'Mr. Sharma', 'Prof Kumar Sharma', 'Not stated']);
});

console.log(`\n${passed} passed`);
