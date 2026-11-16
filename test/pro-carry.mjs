// Open actions carried from the previous meeting of a series into the next minutes, and the review written back.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

const mem = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(mem) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => k in mem).map((k) => [k, JSON.parse(JSON.stringify(mem[k]))]));
      },
      set: async (o) => Object.assign(mem, JSON.parse(JSON.stringify(o))),
      remove: async (k) => [].concat(k).forEach((x) => delete mem[x]),
    },
  },
};
const { createJobRunner, useStore, openActionsAcrossMeetings, setActionDone } = await import('../src/jobs.js');
const { getMeeting, getMeetingMeta, getSettings, saveMeeting, patchMeeting, appendMeeting, listMeetingMetas } = await import('../src/store.js');

let passed = 0;
async function test(name, fn) {
  try {
    for (const k of Object.keys(mem)) delete mem[k];
    useStore({ getMeeting, getMeetingMeta, saveMeeting, patchMeeting, appendMeeting, listMeetingMetas, getSettings }); // the real ones again after a test that removed some
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}

globalThis.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, to: 'me@x.com' }) });

const DAY = 86400000;
const NOW = Date.now();
const SETTINGS = { llmProvider: 'gemini', geminiKey: 'k', geminiModel: 'm', minutesFormat: 'standard', minutesMode: 'quick', minutesEngine: 'structured', calendarLookup: false, emailAuto: false };
const act = (id, text, extra = {}) => ({ id, text, owner: 'Priya Nair', due: 'Friday', at: '00:10', quote: 'q', status: 'open', ...extra });
const PREV_ITEMS = { title: 'Weekly Sync', overview: 'x', summary: [], topics: [], decisions: [], actions: [act('a1x', 'Share the budget sheet'), act('a2y', 'Book the venue')], risks: [], questions: [], next: [] };
const seed = ({ settings = {}, prev = {}, cur = {} } = {}) => {
  mem.settings = { ...SETTINGS, ...settings };
  mem['meeting:p1'] = { id: 'p1', title: 'Weekly Sync 6 Nov', startedAt: NOW - 8 * DAY, endedAt: NOW - 8 * DAY + 600000, segments: [{ t: 1, src: 'others', text: 'old' }], errors: [], mom: '## old', items: PREV_ITEMS, ...prev };
  mem['meeting:m1'] = { id: 'm1', title: 'Weekly Sync 13 Nov', startedAt: NOW - 600000, endedAt: NOW - 1000, segments: [{ t: 1, src: 'others', text: 'The budget sheet went out on Monday.' }, { t: 20, src: 'me', text: 'The venue is still not booked.' }], errors: [], mom: '', ...cur };
  mem.meetingIds = ['m1', 'p1'];
};
const doc = (previous) => JSON.stringify({ title: 'Weekly Sync', overview: 'Budget sent.', summary: ['ok'], topics: [], decisions: [], actions: [{ text: 'Print the agenda', owner: 'Amal', due: 'Monday', at: '00:30', quote: 'print' }], risks: [], questions: [], next: [], ...(previous ? { previous } : {}) });
const asked = [];
const gen = (previous) => async ({ user, json }) => { asked.push(user); return json ? doc(previous) : '## x'; };
const runner = (generate, extra = {}) => createJobRunner({ getSettings, getMeeting, saveMeeting, generate, countdownMs: 5, beatMs: 5, ...extra });
const go = async (generate, opts = { force: true }) => {
  const r = runner(generate);
  r.run('m1', opts);
  await r.whenIdle();
  return r;
};
const statusOf = (m, id) => m.items.actions.find((a) => a.id === id).status;

await test('carry: the open actions go to the model, the previous meeting is updated and this one remembers where they came from', async () => {
  seed();
  asked.length = 0;
  await go(gen([{ id: 'a1x', status: 'Done', note: 'sent Monday' }, { id: 'a2y', status: 'Open', note: 'not yet' }]));
  assert.match(asked[0], /Open action items from the previous meeting in this series \(Weekly Sync 6 Nov, /);
  assert.match(asked[0], /\[id: a1x\] Share the budget sheet/);
  const m = await getMeeting('m1');
  assert.equal(m.job.state, 'done');
  assert.match(m.mom, /## Previous Action Items[\s\S]*\| Share the budget sheet \| Priya Nair \| Friday \| Done \|[\s\S]*\| Book the venue \| Priya Nair \| Friday \| Open \|/);
  assert.deepEqual(m.carriedFrom, { id: 'p1', title: 'Weekly Sync 6 Nov', at: (await getMeeting('p1')).startedAt });
  const p = await getMeeting('p1');
  assert.equal(statusOf(p, 'a1x'), 'done');
  assert.equal(statusOf(p, 'a2y'), 'open');
  assert.ok(p.items.actions[0].doneAt);
  assert.equal(p.mom, '## old', 'nothing else on the previous meeting changed');
  assert.equal(p.carriedFrom, undefined);
});

await test('carry: a rewrite does not double-apply, keeps the table, and never flips a done action back', async () => {
  seed();
  await go(gen([{ id: 'a1x', status: 'done' }, { id: 'a2y', status: 'open' }]));
  const doneAt = (await getMeeting('p1')).items.actions[0].doneAt;
  asked.length = 0;
  // the second run says "open" for the action the first run closed
  await go(gen([{ id: 'a1x', status: 'open', note: 'again?' }, { id: 'a2y', status: 'done' }]), { force: true, reread: true });
  assert.match(asked[0], /\[id: a1x\]/, 'the action closed by this meeting is still listed on a rewrite');
  const p = await getMeeting('p1');
  assert.equal(statusOf(p, 'a1x'), 'done');
  assert.equal(p.items.actions[0].doneAt, doneAt, 'not stamped again');
  assert.equal(statusOf(p, 'a2y'), 'done');
  assert.match((await getMeeting('m1')).mom, /## Previous Action Items/);
});

await test('carry: an action the person marked done by hand is not carried, and nothing reopens it', async () => {
  seed({ prev: { items: { ...PREV_ITEMS, actions: [act('a1x', 'Share the budget sheet', { status: 'done', doneAt: 5 }), act('a2y', 'Book the venue')] } } });
  asked.length = 0;
  await go(gen([{ id: 'a1x', status: 'open' }, { id: 'a2y', status: 'open' }]));
  assert.doesNotMatch(asked[0], /a1x/);
  const p = await getMeeting('p1');
  assert.deepEqual([statusOf(p, 'a1x'), p.items.actions[0].doneAt, statusOf(p, 'a2y')], ['done', 5, 'open']);
});

await test('carry: no open actions, no series, a newer meeting, or the setting off: no carry and the minutes are still written', async () => {
  const cases = [
    ['nothing open', { prev: { items: { ...PREV_ITEMS, actions: [act('a1x', 'x', { status: 'done' })] } } }],
    ['no series', { prev: { title: 'Budget review' } }],
    ['newer meeting', { prev: { startedAt: NOW + DAY } }],
    ['setting off', { settings: { actionCarry: false } }],
  ];
  for (const [name, extra] of cases) {
    seed(extra);
    asked.length = 0;
    await go(gen([{ id: 'a1x', status: 'done' }]));
    const m = await getMeeting('m1');
    assert.equal(m.job.state, 'done', name);
    assert.match(m.mom, /Print the agenda/, name);
    assert.doesNotMatch(asked[0], /Open action items/, name);
    assert.equal(m.carriedFrom, undefined, name);
    assert.doesNotMatch(m.mom, /Previous Action Items/, name);
  }
});

await test('carry: the same meeting type counts as a series even when the titles differ', async () => {
  seed({ settings: { meetingTypes: [{ id: 'cadence', name: 'Cadence', match: 'cadence' }] }, prev: { title: 'Cadence call A' }, cur: { title: 'Kerala cadence' } });
  asked.length = 0;
  await go(gen([{ id: 'a1x', status: 'done' }]));
  assert.match(asked[0], /Cadence call A/);
});

await test('carry: a store that cannot list meetings (the offscreen document before the op exists) means no carry', async () => {
  for (const broken of [undefined, async () => { throw new Error('no chrome.storage'); }]) {
    seed();
    asked.length = 0;
    useStore({ listMeetingMetas: broken });
    await go(gen([{ id: 'a1x', status: 'done' }]));
    const m = await getMeeting('m1');
    assert.equal(m.job.state, 'done');
    assert.match(m.mom, /Print the agenda/);
    assert.doesNotMatch(asked[0], /Open action items/);
    assert.equal(statusOf(await getMeeting('p1'), 'a1x'), 'open');
  }
});

await test('carry: a failure while updating the earlier meeting does not fail the job and is logged', async () => {
  seed();
  const log = [];
  useStore({ appendMeeting: async (id, list, items) => { log.push([id, list, items]); return true; } });
  const r = runner(gen([{ id: 'a1x', status: 'done' }]), { patchMeeting: async (id, f) => { if (id === 'p1') throw new Error('disk full'); return patchMeeting(id, f); } });
  r.run('m1', { force: true });
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.equal(m.job.state, 'done');
  assert.match(m.mom, /Print the agenda/);
  assert.ok(log.some(([id, list, items]) => id === 'm1' && list === 'debug' && /disk full/.test(items[0])));
});

await test('carry: classic engine reads the statuses from the written table', async () => {
  seed({ settings: { minutesEngine: 'classic' } });
  const md = '# Sync\n## Summary\n- ok\n## Previous Action Items\n| # | Action | Owner | Due | Status |\n|---|---|---|---|---|\n| 1 | Share the budget sheet | Priya | Friday | Done |\n| 2 | Book the venue | - | - | Not mentioned |\n## Action items\n- Print the agenda';
  await go(async () => md);
  const p = await getMeeting('p1');
  assert.deepEqual([statusOf(p, 'a1x'), statusOf(p, 'a2y')], ['done', 'open']);
});

await test('actions across meetings and setActionDone: a META patch of items only', async () => {
  seed({ cur: { items: { ...PREV_ITEMS, actions: [act('b1', 'Order chairs', { due: '1 Jan 2020' })] } } });
  const open = await openActionsAcrossMeetings({ today: new Date(NOW) });
  assert.deepEqual(open.map((a) => [a.meetingId, a.id]).sort(), [['m1', 'b1'], ['p1', 'a1x'], ['p1', 'a2y']]);
  assert.equal(open.find((a) => a.id === 'b1').overdue, true);
  assert.equal(await setActionDone('p1', 'a1x', true), true);
  let p = await getMeeting('p1');
  assert.equal(statusOf(p, 'a1x'), 'done');
  assert.equal(p.segments.length, 1);
  assert.equal(await setActionDone('p1', 'a1x', false), true);
  p = await getMeeting('p1');
  assert.deepEqual([statusOf(p, 'a1x'), p.items.actions[0].doneAt], ['open', undefined]);
  assert.equal(await setActionDone('p1', 'nope', true), false);
  assert.equal(await setActionDone('zzz', 'a1x', true), false);
});

console.log(`\n${passed} passed`);
