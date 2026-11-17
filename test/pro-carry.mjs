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

// ---- the webhook (security review M1, L4) ----
const W = await import('../src/webhook.js');
const { renderMinutes } = await import('../src/structured.js');
const HOOK = { webhookUrl: 'https://attacker.example/hook' };
const HOOK_MEETING = { id: 'm1', title: 'Sync', startedAt: NOW - 3600000, endedAt: NOW, mom: '# Sync\n\n## Decisions\n- Ship on Friday. [12:40] "kal tak ship kar denge"', items: { decisions: [{ text: 'Ship on Friday', at: '12:40' }], actions: [act('a1', 'Send the deck', { quote: 'main deck bhej dunga kal' })] } };
// a fake chrome for one test: the offscreen document has runtime (with messaging) and no permissions API
async function withChrome(extra, fn) {
  const keep = { runtime: globalThis.chrome.runtime, permissions: globalThis.chrome.permissions };
  Object.assign(globalThis.chrome, extra);
  try {
    return await fn();
  } finally {
    Object.assign(globalThis.chrome, keep);
    for (const k of Object.keys(keep)) if (keep[k] === undefined) delete globalThis.chrome[k];
  }
}

await test('webhook M1: in the offscreen document the worker is asked by meeting id only, and nothing is fetched there', async () => {
  const asked = [];
  const fetched = [];
  const patches = [];
  const r = await withChrome({ runtime: { sendMessage: async (m) => (asked.push(m), { ok: false, status: 0, error: W.NO_PERMISSION }) } }, () =>
    W.runWebhook(HOOK_MEETING, HOOK, async (p) => patches.push(p), { fetch: async (u) => (fetched.push(u), { status: 200 }) })
  );
  assert.deepEqual(asked, [{ target: 'bg', type: 'webhook-post', meetingId: 'm1' }], 'no address and no minutes in the message');
  assert.deepEqual(fetched, []);
  assert.deepEqual(r, { ok: false, status: 0, error: W.NO_PERMISSION });
  assert.deepEqual(patches, [{ webhookError: W.NO_PERMISSION }]);
  // the worker said yes and posted: the time is written; a worker that is gone or answers nonsense is an error
  const p2 = [];
  await withChrome({ runtime: { sendMessage: async () => ({ ok: true, status: 204 }) } }, () => W.runWebhook(HOOK_MEETING, HOOK, async (p) => p2.push(p)));
  assert.ok(p2[0].webhookAt && p2[0].webhookError === null);
  for (const answer of [() => Promise.reject(new Error('Receiving end does not exist')), async () => undefined, async () => ({ ok: 'yes' })]) {
    const p3 = [];
    const r3 = await withChrome({ runtime: { sendMessage: answer } }, () => W.runWebhook(HOOK_MEETING, HOOK, async (p) => p3.push(p), { fetch: async (u) => (fetched.push(u), { status: 200 }) }));
    assert.equal(r3.ok, false);
    assert.match(p3[0].webhookError, /background worker/);
  }
  assert.deepEqual(fetched, []);
});

await test('webhook M1: the review proof — runtime without messaging and no permissions API sends nothing', async () => {
  let called = null;
  const r = await withChrome({ runtime: {} }, () => W.runWebhook(HOOK_MEETING, HOOK, async () => {}, { fetch: async (u) => ((called = u), { status: 200 }) }));
  assert.equal(called, null);
  assert.equal(r.error, W.NO_PERMISSION);
});

await test('webhook M1: where permissions can be checked, only a clear yes sends', async () => {
  const fetched = [];
  const f = async (u) => (fetched.push(u), { status: 200 });
  for (const contains of [async () => false, async () => { throw new Error('x'); }, async () => 'yes', undefined]) {
    const r = await W.postIfPermitted(HOOK_MEETING, HOOK, { fetch: f, contains: contains || null });
    assert.deepEqual(r, { ok: false, status: 0, error: W.NO_PERMISSION });
  }
  assert.deepEqual(fetched, []);
  const asked = [];
  assert.equal((await W.postIfPermitted(HOOK_MEETING, HOOK, { fetch: f, contains: async (q) => (asked.push(q), true) })).ok, true);
  assert.deepEqual(asked, [{ origins: ['https://attacker.example/*'] }]);
  assert.deepEqual(fetched, ['https://attacker.example/hook']);
  // with chrome.permissions present (the service worker, an own page) runWebhook checks it itself
  const p = [];
  await withChrome({ permissions: { contains: async () => false }, runtime: { sendMessage: async () => assert.fail('must not delegate') } }, () => W.runWebhook(HOOK_MEETING, HOOK, async (x) => p.push(x), { fetch: f }));
  assert.deepEqual(p, [{ webhookError: W.NO_PERMISSION }]);
  assert.equal(fetched.length, 1);
  const local = await W.postIfPermitted(HOOK_MEETING, { webhookUrl: 'http://127.0.0.1:8123/h' }, { fetch: f, contains: async (q) => q.origins[0] === 'http://127.0.0.1:8123/*' });
  assert.equal(local.ok, true, 'an address on this computer needs (and gets) its own permission check');
});

await test('webhook L4: the minutes sent carry no transcript quotes, in either table layout, and email addresses stay hidden', async () => {
  const md = [
    '# Sync', '', '## Decisions', '- Ship on Friday. [12:40] "kal tak ship kar denge"', '- Hire two people [1:02:03] “do log chahiye”', '- No stamp, "a title in quotes" stays', '',
    '## Action Items', '| # | Action | Owner | Due | Source |', '|---|--------|-------|-----|--------|',
    '| 1 | Send the deck | Amal (amal@x.com) | Friday | [12:40] "main deck bhej \\| dunga" |', '| 2 | Book a room | Not stated | Not stated | "quote only" |', '| 3 | Call Ravi | Ravi | Monday | — |', '',
    '## Updates by person', '| Name | Update |', '|---|---|', '| Amal | "Done" with the API [3:00] |', '',
    'Source | Action | Owner', '--- | --- | ---', '[0:10] "secret words here" | Check logs | Bina',
  ].join('\n');
  const out = W.withoutQuotes(md);
  assert.ok(!/kal tak|do log|main deck|quote only|secret words/.test(out), out);
  assert.match(out, /- Ship on Friday\. \[12:40\]\n/);
  assert.match(out, /- Hire two people \[1:02:03\]\n/);
  assert.match(out, /No stamp, "a title in quotes" stays/);
  assert.match(out, /\| 1 \| Send the deck \| Amal \(amal@x\.com\) \| Friday \| \[12:40\] \|/);
  assert.match(out, /\| 2 \| Book a room \| Not stated \| Not stated \| — \|/);
  assert.match(out, /\| 3 \| Call Ravi \| Ravi \| Monday \| — \|/);
  assert.match(out, /\| Amal \| "Done" with the API \[3:00\] \|/, 'a table without a Source column is left as it is');
  assert.match(out, /\n \[0:10\] \| Check logs \| Bina$/, 'a table without the outer pipes too');
  assert.equal(W.withoutQuotes(out), out, 'running it twice changes nothing');
  // the payload: stored minutes (any sections, the person's edits) without quotes; items only -> rendered without Source
  const withEvidence = renderMinutes(HOOK_MEETING.items, { meeting: HOOK_MEETING });
  assert.match(withEvidence, /main deck bhej dunga kal/, 'the page keeps its sources');
  for (const m of [{ ...HOOK_MEETING, mom: withEvidence }, { ...HOOK_MEETING, mom: '' }, { ...HOOK_MEETING, mom: md }]) {
    const body = W.webhookPayload(m);
    assert.ok(!/main deck|kal tak|do log|quote only|secret words/.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 400));
    assert.ok(!/amal@x\.com/.test(JSON.stringify(body)));
    assert.match(body.minutesMarkdown, /Send the deck|Ship on Friday/);
  }
  assert.doesNotMatch(W.webhookPayload({ ...HOOK_MEETING, mom: '' }).minutesMarkdown, /Source/);
});

console.log(`\n${passed} passed`);
