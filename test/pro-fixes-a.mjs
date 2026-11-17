// Regressions from the 1.4 review (store, job, minutes): a stale page copy never takes back what the job wrote, a meeting
// deleted while its minutes are written gets no email, share, webhook or carry, a cut-off model answer is never taken as
// whole minutes, ticks made during a rewrite survive it, the completeness edit keeps the points it did not add, owners said
// in another script are kept, forgetting voices takes the lock, and a growing caption is not doubled at a chunk boundary.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mem = {};
const json = (v) => JSON.parse(JSON.stringify(v));
let onGet = null; // a hook: called with the keys of every get, between reading and answering
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(mem) : Array.isArray(keys) ? keys : [keys];
        const out = Object.fromEntries(list.filter((k) => k in mem).map((k) => [k, json(mem[k])]));
        if (onGet) await onGet(list); // after the read: what was read is already old if the hook writes
        return out;
      },
      set: async (o) => Object.assign(mem, json(o)),
      remove: async (k) => [].concat(k).forEach((x) => delete mem[x]),
    },
  },
};

const MS = await import('../src/meetingstore.js');
const S = await import('../src/store.js');
const J = await import('../src/jobs.js');
const ST = await import('../src/structured.js');
const { writeMinutes, stillMissing, coverageMarkdown, CUT_OFF_WARNING } = await import('../src/minutes.js');
const { generate } = await import('../src/llm.js');
const { getMeeting, saveMeeting, patchMeeting, getSettings } = S;

let passed = 0;
async function test(name, fn) {
  try {
    for (const k of Object.keys(mem)) delete mem[k];
    onGet = null;
    sent.length = 0;
    hooks.length = 0;
    J.useStore({ getMeeting: S.getMeeting, getMeetingMeta: S.getMeetingMeta, saveMeeting: S.saveMeeting, patchMeeting: S.patchMeeting, updateMeetingMeta: S.updateMeetingMeta, appendMeeting: S.appendMeeting, listMeetingMetas: S.listMeetingMetas, getSettings: S.getSettings, saveMinutes: undefined });
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 6).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const sent = []; // emails
const hooks = []; // webhook posts
let realFetch = null; // set by the llm tests
globalThis.fetch = async (url, init) => {
  if (realFetch) return realFetch(url, init);
  if (!String(url).includes('script.google.com')) {
    hooks.push(String(url));
    return { status: 200, ok: true, text: async () => '' };
  }
  sent.push(JSON.parse(init.body));
  return { status: 200, text: async () => JSON.stringify({ ok: true, to: String(JSON.parse(init.body).to || 'me@x.com') }) };
};

const meetingKeys = (id) => Object.keys(mem).filter((k) => k === `meeting:${id}` || k.startsWith(`mp:${id}:`));

// ---------------- 1. a stale copy never takes back META written meanwhile ----------------
// every field whose loss matters, with the value the job (or the background) writes while a page holds an older copy
const DANGEROUS = {
  emailedAt: 1700000000123, emailedTo: 'me@x.com', emailSending: 1700000000100, sharedAt: 1700000000200, sharedTo: ['a@x.com'], shareHeld: ['x@other.com'],
  job: { state: 'done', beat: 5 }, mom: '# Minutes\n\n- ship Friday', items: { actions: [{ id: 'a1', text: 'x', status: 'done', doneBy: 'm9' }] },
  extract: { key: 'k', items: [] }, webhookAt: 1700000000300, decided: true, carriedFrom: { id: 'p1', title: 'Prev', at: 1 },
};

await test('META: a page copy saving its title after the job wrote the minutes and the email keeps mom, items and emailedAt (review title.mjs)', async () => {
  await saveMeeting({ id: 'm1', title: 'Untitled', segments: [{ t: 1, text: 'hi' }], errors: [], mom: '', job: { state: 'writing' } });
  const page = await getMeeting('m1');
  await patchMeeting('m1', { mom: '# Minutes ...', items: { actions: [] } });
  await patchMeeting('m1', { emailSending: null, emailedAt: 42, emailedTo: 'me@x.com' });
  page.title = 'Weekly sync';
  await saveMeeting(page);
  const m = await getMeeting('m1');
  assert.deepEqual([m.title, m.mom, m.emailedAt, m.emailedTo, m.items], ['Weekly sync', '# Minutes ...', 42, 'me@x.com', { actions: [] }]);
  assert.equal(m.emailSending, null);
});

await test('META: none of the fields whose loss matters can be reverted by a stale copy (plain, spread, and sent by message)', async () => {
  for (const how of ['plain', 'spread', 'assign', 'wire']) {
    for (const [field, value] of Object.entries(DANGEROUS)) {
      for (const k of Object.keys(mem)) delete mem[k];
      const before = field === 'emailSending' ? { emailSending: null } : field === 'decided' ? { decided: false } : {};
      await saveMeeting({ id: 'm1', title: 'T', segments: [{ t: 1, text: 'hi' }], errors: [], mom: '', ...before });
      let page = await getMeeting('m1');
      await patchMeeting('m1', { [field]: value }); // the job
      if (how === 'spread') page = { ...page };
      if (how === 'assign') page = Object.assign({}, page);
      page.title = 'Renamed';
      if (how === 'wire') await saveMeeting(json(MS.withWireStamps(page))); // the offscreen document's way
      else await saveMeeting(page);
      const m = await getMeeting('m1');
      assert.deepEqual(m[field], value, `${how}: ${field} was reverted`);
      assert.equal(m.title, 'Renamed', `${how}: ${field}`);
    }
  }
});

await test('META: what a copy did change is written (added, changed, removed); an unmarked record is written whole', async () => {
  await saveMeeting({ id: 'm1', title: 'T', segments: [], errors: [], notes: 'old notes', mom: '' });
  const page = await getMeeting('m1');
  await patchMeeting('m1', { mom: 'job minutes' });
  page.attendees = ['Amal'];
  page.notes = 'new notes';
  delete page.title;
  await saveMeeting(page);
  let m = await getMeeting('m1');
  assert.deepEqual([m.attendees, m.notes, m.title, m.mom], [['Amal'], 'new notes', undefined, 'job minutes']);
  // a backup's record (no marks) is written as it is
  await saveMeeting({ id: 'm1', title: 'From backup', segments: [], errors: [] });
  m = await getMeeting('m1');
  assert.deepEqual([m.title, m.mom, m.notes], ['From backup', undefined, undefined]);
  // saving the same copy twice writes nothing new the second time
  const c = await getMeeting('m1');
  c.title = 'Again';
  await saveMeeting(c);
  await patchMeeting('m1', { mom: 'later' });
  await saveMeeting(c);
  assert.equal((await getMeeting('m1')).mom, 'later');
});

await test('META: the job\'s emulated append (read, push, save) does not take back a tick made meanwhile (review emu.mjs)', async () => {
  await saveMeeting({ id: 'm1', title: 'T', segments: [], errors: [], debug: [], items: { actions: [{ id: 'a1', text: 'x', status: 'open' }] } });
  const m = MS.stampLoaded(json(await MS.getMeeting('m1')));
  await patchMeeting('m1', { items: { actions: [{ id: 'a1', text: 'x', status: 'done' }] } });
  m.debug.push('carrying actions skipped: ...');
  await saveMeeting(json(MS.withWireStamps(m)));
  const after = await getMeeting('m1');
  assert.deepEqual([after.debug.length, after.items.actions[0].status], [1, 'done']);
});

await test('pages: the minutes page saves single fields with patches and never writes back a deleted meeting', () => {
  const src = readFileSync(new URL('../src/mom.js', import.meta.url), 'utf8');
  assert.ok(!/saveMeeting\(meeting\)/.test(src), 'mom.js saves its whole (possibly stale) copy');
  assert.ok(/patchMeeting\(\{ title:/.test(src), 'the title is a patch');
  assert.ok(!/\|\| meeting;/.test(src.slice(src.indexOf('async function fixName'))), 'fixName falls back to the page copy');
  for (const f of ['mom.js', 'popup.js']) assert.ok(!/await deleteMeeting\(/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')), `${f} deletes without stopping the job`);
});

// ---------------- 2. deleting a meeting while its minutes are written ----------------
const JOB_SETTINGS = { llmProvider: 'gemini', geminiKey: 'k', geminiModel: 'm', minutesFormat: 'standard', minutesMode: 'quick', minutesEngine: 'classic', calendarLookup: false, emailAuto: true, emailWebhook: 'https://script.google.com/macros/s/abc/exec', emailSecret: 'x'.repeat(30) };
const seedJob = (settings = {}, extra = {}) => {
  mem.settings = { ...JOB_SETTINGS, ...settings };
  mem['meeting:m1'] = { id: 'm1', title: 'Sync', startedAt: Date.now() - 600000, endedAt: Date.now() - 1000, segments: [{ t: 1, src: 'others', text: 'We agreed to ship on Friday.' }], errors: [], mom: '', ...extra };
  mem.meetingIds = ['m1'];
};
const runJob = async (gen, deps = {}) => {
  const r = J.createJobRunner({ generate: gen, countdownMs: 0, beatMs: 5, webhook: { retryMs: 1, sleep: async () => {}, timeoutMs: 100 }, ...deps });
  r.run('m1', { force: true });
  await r.whenIdle();
};

await test('delete: a meeting deleted while the model writes gets no email, no share, no webhook, and no key comes back (review del.mjs)', async () => {
  seedJob({ shareMode: 'auto', shareList: 'a@x.com', webhookUrl: 'https://example.com/hook' });
  await runJob(async () => {
    await S.deleteMeeting('m1');
    return '# Minutes\n\n## Summary\n- ship Friday';
  });
  await new Promise((r) => setTimeout(r, 30)); // a late heartbeat would land here
  assert.deepEqual(meetingKeys('m1'), []);
  assert.equal(sent.length, 0, 'emails sent');
  assert.equal(hooks.length, 0, 'webhook posts');
  assert.deepEqual(mem.meetingIds, []);
});

await test('delete: no further model call once the meeting is gone (thorough classic: extraction windows, writing, check)', async () => {
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
  seedJob({ minutesMode: 'thorough' }, { segments: Array.from({ length: 12 }, (_, i) => ({ t: i * 30, src: 'others', text: `${words.slice(i * 500, i * 500 + 3000)}` })) });
  let calls = 0;
  await runJob(async () => {
    calls++;
    if (calls === 1) await S.deleteMeeting('m1');
    return 'ACTION | Amal | Friday | [00:10] | x | "x"';
  });
  assert.equal(calls, 1);
  assert.deepEqual(meetingKeys('m1'), []);
  assert.equal(sent.length, 0);
});

await test('delete: the earlier meeting in the series is not updated for a meeting deleted mid-write', async () => {
  const DAY = 86400000;
  const now = Date.now();
  const act = (id, text) => ({ id, text, owner: 'Priya', due: 'Friday', at: '00:10', quote: 'q', status: 'open' });
  mem.settings = { ...JOB_SETTINGS, minutesEngine: 'structured', emailAuto: false };
  mem['meeting:p1'] = { id: 'p1', title: 'Weekly Sync 6 Nov', startedAt: now - 8 * DAY, endedAt: now - 8 * DAY + 600000, segments: [{ t: 1, src: 'others', text: 'old' }], errors: [], mom: '## old', items: { overview: 'x', summary: [], topics: [], decisions: [], actions: [act('a1x', 'Share the budget sheet')], risks: [], questions: [], next: [] } };
  mem['meeting:m1'] = { id: 'm1', title: 'Weekly Sync 13 Nov', startedAt: now - 600000, endedAt: now - 1000, segments: [{ t: 1, src: 'others', text: 'The budget sheet went out on Monday.' }], errors: [], mom: '' };
  mem.meetingIds = ['m1', 'p1'];
  await runJob(async ({ json: j }) => {
    await S.deleteMeeting('m1');
    return j ? JSON.stringify({ overview: 'Budget sent.', summary: [], topics: [], decisions: [], actions: [], previous: [{ id: 'a1x', status: 'done' }] }) : '## x';
  });
  assert.equal((await getMeeting('p1')).items.actions[0].status, 'open');
  assert.deepEqual(meetingKeys('m1'), []);
});

await test('delete: patch, META update, append and tail edit on a missing meeting re-create nothing', async () => {
  assert.equal(await MS.patchMeeting('gone', { job: { state: 'done' }, segments: [{ t: 1 }] }), null);
  assert.equal(await MS.updateMeetingMeta('gone', (m) => (m.mom = 'x')), null);
  assert.equal(await MS.appendMeeting('gone', 'debug', ['x']), false);
  assert.equal(await MS.editMeetingTail('gone', 'captions', (t) => void t.push({ t: 1 })), false);
  assert.deepEqual(meetingKeys('gone'), []);
});

await test('delete: the automatic email does nothing when the latest copy is gone', async () => {
  const r = await J.emailMinutes({ meeting: { id: 'm1', mom: '# x', endedAt: 1 }, settings: JOB_SETTINGS, auto: true, patch: async () => null, getLatest: async () => null, ctxFor: () => ({}) });
  assert.equal(r.deleted, true);
  assert.equal(sent.length, 0);
});

await test('delete: deleting from a page asks the background to stop the job first, and works where there is no runtime', async () => {
  seedJob();
  await S.deleteMeetingAndStop('m1'); // node: no chrome.runtime
  assert.deepEqual(meetingKeys('m1'), []);
  seedJob();
  const msgs = [];
  chrome.runtime = { sendMessage: async (m) => (msgs.push([m, meetingKeys('m1').length]), { ok: true }) };
  try {
    await S.deleteMeetingAndStop('m1');
  } finally {
    delete chrome.runtime;
  }
  assert.deepEqual(msgs, [[{ target: 'bg', type: 'job-abort', id: 'm1' }, 1]], 'the abort goes out before the records are removed');
  assert.deepEqual(meetingKeys('m1'), []);
});

// ---------------- 4. a cut-off answer ----------------
const GOOD = { title: 'T', overview: 'o', summary: ['s'], topics: [{ title: 'A', status: '', points: ['p1'] }], decisions: [{ text: 'd1', at: '01:00' }], actions: [{ text: 'Run load test', owner: 'Not stated', due: 'Not stated', at: '02:00', quote: '' }, { text: 'Send report', owner: 'Not stated', due: 'Fri', at: '03:00', quote: '' }], risks: [], questions: [], next: [] };
const FULL = JSON.stringify(GOOD);
const CUT = FULL.slice(0, FULL.indexOf('Send report') + 4);

await test('truncated: a half-written last item is dropped, with or without the old cut-off note, and the reply says it was cut (review trunc.mjs)', () => {
  for (const t of [CUT, `${CUT}\n\n_(Output hit the length limit and was cut off.)_`]) {
    const r = ST.parseStructuredReply(t);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.items.actions.map((a) => a.text), ['Run load test']);
  }
  assert.equal(ST.parseStructuredReply(FULL).truncated, false);
  assert.equal(ST.parseStructuredReply(FULL).items.actions.length, 2);
});

const sse = (events) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.join(''))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
await test('truncated: every provider reports hitting the answer limit through onMeta; Claude adds no note to JSON', async () => {
  const cases = [
    [{ llmProvider: 'gemini', geminiKey: 'g', geminiModel: 'gem' }, ['data: {"candidates":[{"content":{"parts":[{"text":"{\\"a\\":"}]},"finishReason":"MAX_TOKENS"}]}\r\n\r\n'], ['data: {"candidates":[{"content":{"parts":[{"text":"{}"}]},"finishReason":"STOP"}]}\r\n\r\n']],
    [{ llmProvider: 'openai', oaBase: 'http://localhost:1/v1', oaModel: 'm' }, ['data: {"choices":[{"delta":{"content":"{\\"a\\":"},"finish_reason":"length"}]}\n\n', 'data: [DONE]\n\n'], ['data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']],
    [{ llmProvider: 'anthropic', anthropicKey: 'k', anthropicModel: 'claude-sonnet-4-5' }, ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"a\\":"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n'], ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n']],
  ];
  try {
    for (const [s, cut, whole] of cases) {
      for (const [events, want] of [[cut, true], [whole, false]]) {
        realFetch = async () => sse(events);
        const metas = [];
        const text = await generate({ settings: s, system: 'S', user: 'U', onText: () => {}, json: true, onMeta: (m) => metas.push(m) });
        assert.equal(metas.some((m) => m.truncated), want, `${s.llmProvider} ${want}`);
        assert.ok(!/length limit/.test(text), `${s.llmProvider}: note inside the reply`);
      }
    }
    // without onMeta and without json (Ask, other callers) Claude keeps its note
    realFetch = async () => sse(cases[2][1]);
    assert.match(await generate({ settings: cases[2][0], system: 'S', user: 'U', onText: () => {} }), /cut off/);
  } finally {
    realFetch = null;
  }
});

const MEETING = { id: 'm1', title: 'Sync', startedAt: 1_700_000_000_000, endedAt: 1_700_000_600_000, invited: [], segments: [{ t: 60, src: 'others', text: 'We decided d1.' }, { t: 120, src: 'others', text: 'Run the load test please.' }] };
const LONG = { ...MEETING, segments: Array.from({ length: 40 }, (_, i) => ({ t: i * 15, src: 'others', text: Array.from({ length: 90 }, (_, k) => `w${i}x${k}`).join(' ') })) };
const SETTINGS = { ...S.DEFAULTS, momLanguage: 'English', minutesFormat: 'standard', minutesEngine: 'structured', minutesMode: 'thorough' };
const CLASSIC = '# Sync\n\n## Overview\nx\n\n## Action Items\n| # | Action | Owner | Due | Source |\n|---|--------|-------|-----|--------|\n| 1 | Run the load test | Not stated | Not stated | [02:00] |\n';
const fakeModel = (log, { structured = FULL, cutStructured = false, cutClassic = false, check = 'NONE', fix } = {}) => async (system, user, onText, opts) => {
  log.push(system);
  if (/EDITING minutes/.test(system)) return fix;
  if (/ONE JSON document/.test(system)) {
    if (cutStructured) opts?.onMeta?.({ truncated: true });
    return structured;
  }
  if (/audit meeting minutes/.test(system)) return check;
  if (/extract facts/.test(system)) return 'ACTION | Not stated | Not stated | [02:00] | run the load test | "run the load test"';
  if (cutClassic) opts?.onMeta?.({ truncated: true });
  return CLASSIC;
};

await test('truncated: a long meeting whose structured answer was cut off is written the classic way, window by window (whole minutes: no cut-off warning)', async () => {
  for (const variant of [{ structured: CUT }, { structured: FULL, cutStructured: true }]) {
    const log = [];
    const status = [];
    const r = await writeMinutes({ meeting: LONG, settings: SETTINGS, notes: '', gen: fakeModel(log, variant), ctx: {}, onStatus: (t) => status.push(t) });
    assert.equal(r.stats.fellBack, 'classic');
    assert.ok(log.some((s) => /extract facts/.test(s)), 'the windowed extraction ran');
    assert.ok(status.some((t) => /cut off/.test(t)), status.join(' | '));
    assert.ok(r.mom.includes(CUT_OFF_WARNING) === false, 'the classic minutes were whole');
    assert.ok(!/Send\b/.test(r.mom));
  }
});

await test('truncated: minutes made from a cut-off answer (short structured, classic) carry one coverage warning', async () => {
  // short meeting, structured: what came back whole is kept
  let r = await writeMinutes({ meeting: MEETING, settings: SETTINGS, notes: '', gen: fakeModel([], { structured: CUT }), ctx: {} });
  assert.deepEqual(r.items.actions.map((a) => a.text), ['Run load test']);
  assert.equal(r.mom.split(CUT_OFF_WARNING).length, 2);
  assert.match(r.mom, /\*\*Coverage warning:\*\* The model's answer was cut off/);
  // classic engine
  r = await writeMinutes({ meeting: MEETING, settings: { ...SETTINGS, minutesEngine: 'classic' }, notes: '', gen: fakeModel([], { cutClassic: true }), ctx: {} });
  assert.equal(r.mom.split(CUT_OFF_WARNING).length, 2);
  // a whole answer: no warning
  r = await writeMinutes({ meeting: MEETING, settings: SETTINGS, notes: '', gen: fakeModel([]), ctx: {} });
  assert.ok(!r.mom.includes(CUT_OFF_WARNING));
  assert.match(coverageMarkdown({ gaps: [], pendingCount: 1, pendingSec: 60, truncated: true }), /^\*\*Coverage warning:\*\* about 1 min .* The model's answer was cut off/);
});

// ---------------- 5. ticks made during a rewrite ----------------
await test('ticks: a rewrite keeps doneBy, and a tick made while the model wrote survives the final save (review tbl.mjs)', async () => {
  const a = ST.assignIds({ actions: [{ text: 'Run load test', owner: 'A', due: '', at: '01:00' }] }, { actions: [{ id: 'aX', text: 'Run load test', at: '01:00', status: 'done', doneAt: 1, doneBy: 'm2' }] });
  assert.deepEqual([a.actions[0].id, a.actions[0].status, a.actions[0].doneAt, a.actions[0].doneBy], ['aX', 'done', 1, 'm2']);
  const items = ST.assignIds({ overview: 'o', summary: [], topics: [], decisions: [], risks: [], questions: [], next: [], actions: [{ text: 'Run load test', owner: 'A', due: 'Fri', at: '00:01', quote: '' }, { text: 'Book room', owner: 'B', due: 'Fri', at: '00:01', quote: '' }] });
  // the service worker's 'saveMinutes' store op as proposed for background.js, for the offscreen document
  const saveMinutes = (id, fields) => S.updateMeetingMeta(id, (m) => Object.assign(m, fields.items ? { ...fields, items: J.keepStatuses(fields.items, m.items) } : fields));
  for (const viaOffscreen of [false, 'fallback', 'saveMinutes']) {
    for (const k of Object.keys(mem)) delete mem[k];
    seedJob({ minutesEngine: 'structured', emailAuto: false }, { mom: '# old', items });
    // by message there is no updateMeetingMeta (a function cannot be sent): a re-read just before the patch, or the worker's op
    if (viaOffscreen) J.useStore({ getMeeting: S.getMeeting, saveMeeting: S.saveMeeting, patchMeeting: S.patchMeeting, getMeetingMeta: S.getMeetingMeta, ...(viaOffscreen === 'saveMinutes' ? { saveMinutes } : {}) });
    await runJob(async ({ json: j }) => {
      // the person ticks one action and another meeting closes the other while the minutes are rewritten
      await J.setActionDone('m1', items.actions[0].id, true);
      const cur = await S.getMeetingMeta('m1', { counts: [] });
      await patchMeeting('m1', { items: { ...cur.items, actions: cur.items.actions.map((x, i) => (i === 1 ? { ...x, status: 'done', doneAt: 7, doneBy: 'm7' } : x)) } });
      return j ? JSON.stringify({ overview: 'o', summary: [], topics: [], decisions: [], actions: items.actions.map(({ id, status, ...x }) => x), risks: [], questions: [], next: [] }) : '## x';
    });
    const m = await getMeeting('m1');
    assert.equal(m.job.state, 'done', `${viaOffscreen}`);
    assert.deepEqual(m.items.actions.map((x) => [x.status, x.doneBy]), [['done', undefined], ['done', 'm7']], `offscreen: ${viaOffscreen}`);
  }
  assert.deepEqual(J.keepStatuses({ actions: [{ id: 'a', status: 'done', doneAt: 1, doneBy: 'x' }] }, { actions: [{ id: 'a', status: 'open' }] }).actions[0], { id: 'a', status: 'open' }, 'reopened meanwhile: open');
});

// ---------------- 6. the completeness edit adds only some points ----------------
await test('completeness: an edit that adds one of two missed points is kept, and only the other one is listed for review', async () => {
  const withOne = { ...GOOD, decisions: [...GOOD.decisions, { text: 'Freeze the schema', at: '00:20' }] };
  const check = '[00:20] schema freeze agreed | "freeze"\n[05:40] Priya to renew the SSL certificate | "renew"';
  const r = await writeMinutes({ meeting: LONG, settings: { ...SETTINGS, minutesMode: 'thorough' }, notes: '', gen: fakeModel([], { check, fix: JSON.stringify(withOne) }), ctx: {} });
  assert.equal(r.stats.merged, true);
  assert.ok(r.items.decisions.some((d) => d.text === 'Freeze the schema'));
  assert.match(r.mom, /## Added by the completeness check[\s\S]*\[05:40\] Priya to renew the SSL certificate/);
  assert.ok(!/- \[00:20\] schema freeze/.test(r.mom), 'the point the edit added is not listed again');
  // by words when the time does not match; a point already near an old entry still counts as missing
  assert.deepEqual(stillMissing(['[09:00] renew the SSL certificate', '[01:00] d1 again'], { ...GOOD, topics: [{ title: 'Ops', points: ['Priya will renew the SSL certificate'] }] }, GOOD), ['[01:00] d1 again']);
});

// ---------------- 7. owners said in another script ----------------
await test('owners: a Latin owner said in Devanagari in a mixed line is kept; a dictionary name counts as known (review guard.mjs)', () => {
  const transcript = '[12:40] Others: राहुल, तुम staging पर load test run कर देना Thursday तक';
  for (const owner of ['Rahul', 'राहुल']) {
    const out = ST.guardStructured({ actions: [{ text: 'Run the load test on staging', owner, due: 'Thursday', at: '12:40', quote: '' }] }, { transcript, attendees: ['Me'] });
    assert.equal(out.actions[0].owner, owner);
    assert.equal(out.actions[0].ownerDropped, undefined);
  }
  // all-English stretch: a made-up owner is still dropped
  const en = '[00:10] Others: please run the load test on staging by Thursday.\n[00:30] Others: fine.\n[05:00] Others: राहुल ने कहा ठीक है';
  const out = ST.guardStructured({ actions: [{ text: 'Run the load test', owner: 'Kiran', due: 'Thursday', at: '00:10', quote: '' }] }, { transcript: en, attendees: ['Me'] });
  assert.equal(out.actions[0].owner, 'Not stated');
  // a skeleton match across scripts outside the ±60 s stretch, and a dictionary name
  const far = '[00:10] Others: run the load test, अमल\n[09:00] Others: ok';
  assert.equal(ST.guardStructured({ actions: [{ text: 'x', owner: 'Amal', due: '', at: '', quote: '' }] }, { transcript: far, attendees: [] }).actions[0].owner, 'Amal');
  const dict = ST.guardStructured({ actions: [{ text: 'x', owner: 'Deepak Shah', due: '', at: '00:10', quote: '' }] }, { transcript: en, attendees: [], entries: [{ name: 'Deepak Shah', aliases: [] }] });
  assert.equal(dict.actions[0].owner, 'Deepak Shah');
});

// ---------------- 8. forgetting voices takes each meeting's lock ----------------
await test('voices: stripping the fingerprints does not overwrite the minutes written while it ran', async () => {
  await saveMeeting({ id: 'm1', title: 'T', segments: [{ t: 1, text: 'x' }], errors: [], voiceSegs: [{ t0: 0, t1: 1, e: 'q' }], voiceModel: 'w', mom: '' });
  mem.meetingIds = ['m1'];
  let job = null;
  let armed = true;
  onGet = async (keys) => {
    if (armed && keys.includes('meeting:m1') && !keys.includes('meetingIds')) {
      armed = false;
      job = patchMeeting('m1', { mom: '# written meanwhile' }); // not awaited: it waits for the lock where there is one
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  assert.equal(await MS.stripVoicesFromAll(), 1);
  await job;
  onGet = null;
  const m = await getMeeting('m1');
  assert.deepEqual([m.mom, m.voiceSegs, m.voiceModel], ['# written meanwhile', undefined, undefined]);
});

// ---------------- 9. a growing caption at a chunk boundary ----------------
// the service worker's merge (background.js 'captions'), unchanged; it asks for { look: 40 } (the last 40 lines it searches)
const mergeCaptions = (incoming) => (caps) => {
  for (const c of incoming) {
    let last = null;
    for (let i = caps.length - 1; i >= 0 && i > caps.length - 40; i--) if (caps[i].name === c.name) {
      last = caps[i];
      break;
    }
    if (last && c.t - last.t2 < 15 && (c.text.startsWith(last.text) || last.text.startsWith(c.text))) {
      last.text = c.text.length >= last.text.length ? c.text : last.text;
      last.t2 = c.t;
    } else caps.push({ t: c.t, t2: c.t, name: c.name, text: c.text });
  }
};
await test('captions: a caption that grows just after a new chunk opened replaces its earlier version instead of being added twice', async () => {
  await saveMeeting({ id: 'm1', title: 'T', segments: [], errors: [] });
  const filler = Array.from({ length: MS.CHUNK - 1 }, (_, i) => ({ t: i, t2: i, name: `P${i % 3}`, text: `line ${i}` }));
  await MS.appendMeeting('m1', 'captions', [...filler, { t: 500, t2: 500, name: 'Amal', text: 'We will ship' }]); // chunk 0 is full
  await MS.editMeetingTail('m1', 'captions', mergeCaptions([{ t: 501, name: 'Priya', text: 'Okay' }]), { look: 40 }); // opens chunk 1
  await MS.editMeetingTail('m1', 'captions', mergeCaptions([{ t: 503, name: 'Amal', text: 'We will ship on Friday' }]), { look: 40 });
  const caps = (await getMeeting('m1')).captions;
  assert.equal(caps.filter((c) => c.name === 'Amal').length, 1, caps.slice(-3).map((c) => c.text).join(' | '));
  assert.equal(caps.find((c) => c.name === 'Amal').text, 'We will ship on Friday');
  assert.equal(caps.length, MS.CHUNK + 1);
  assert.equal(mem['meeting:m1'].parts.captions.chunks, 2);
  assert.equal(mem['mp:m1:captions:0'].length, MS.CHUNK);
});

console.log(`\n${passed} passed`);
process.exit(process.exitCode || 0);
