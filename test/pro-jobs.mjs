// The minutes job: written and emailed by the background runner with no minutes tab open, finishing even if the viewer
// goes away, resuming after a restart with exactly one email, and one job however often the page is opened.
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
const { createJobRunner, stuckJobs, isActive } = await import('../src/jobs.js');
const { getMeeting, getSettings, saveMeeting } = await import('../src/store.js');

let passed = 0;
async function test(name, fn) {
  try {
    for (const k of Object.keys(mem)) delete mem[k];
    sent.length = 0;
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push(JSON.parse(init.body));
  return { status: 200, text: async () => JSON.stringify({ ok: true, to: 'me@x.com' }) };
};

const SETTINGS = {
  llmProvider: 'gemini', geminiKey: 'k', geminiModel: 'm', minutesFormat: 'standard', minutesMode: 'quick', calendarLookup: false,
  emailAuto: true, emailWebhook: 'https://script.google.com/macros/s/abc/exec', emailSecret: 'x'.repeat(30),
};
const seed = (extra = {}) => {
  mem.settings = SETTINGS;
  mem['meeting:m1'] = { id: 'm1', title: 'Sync', startedAt: Date.now() - 600000, endedAt: Date.now() - 1000, segments: [{ t: 1, src: 'others', text: 'We agreed to ship on Friday.' }, { t: 20, src: 'me', text: 'I will send the notes.' }], errors: [], mom: '', ...extra };
  mem.meetingIds = ['m1'];
};
let calls = 0;
const generate = async ({ onText }) => {
  calls++;
  const text = '## Summary\nShip on Friday.\n\n## Action items\n- Send notes';
  onText?.(text);
  return text;
};
const runner = (extra = {}) => createJobRunner({ getSettings, getMeeting, saveMeeting, generate, countdownMs: 20, beatMs: 5, ...extra });

await test('the meeting ends, no minutes tab is ever opened, and the minutes and the email still happen', async () => {
  seed();
  calls = 0;
  const r = runner();
  assert.deepEqual(r.run('m1'), { ok: true, started: true });
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.match(m.mom, /Ship on Friday/);
  assert.equal(m.job.state, 'done');
  assert.ok(m.emailedAt, 'emailed');
  assert.equal(sent.length, 1);
  assert.equal(calls, 1);
});

await test('the viewer going away mid-generation does not stop the job', async () => {
  seed();
  let heard = 0;
  const r = runner({ emit: () => { heard++; if (heard > 2) throw new Error('the minutes tab was closed'); } });
  r.run('m1');
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.equal(m.job.state, 'done');
  assert.ok(m.mom && m.emailedAt);
  assert.equal(sent.length, 1);
});

await test('opening the page twice (or three times) is one job and one email', async () => {
  seed();
  calls = 0;
  const r = runner();
  const a = r.run('m1');
  const b = r.run('m1');
  const c = r.run('m1', { force: true });
  assert.deepEqual([a.started, b.running, c.running], [true, true, true]);
  await r.whenIdle();
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
  assert.equal(r.count(), 0);
});

await test('after a restart the job resumes, with exactly one email', async () => {
  // died while writing: the beat is old
  seed({ job: { state: 'writing', beat: Date.now() - 120000 }, decided: true });
  calls = 0;
  const found = stuckJobs([await getMeeting('m1')]);
  assert.deepEqual(found, ['m1']);
  const r = runner();
  r.run('m1', { resume: true });
  await r.whenIdle();
  let m = await getMeeting('m1');
  assert.equal(m.job.state, 'done');
  assert.equal(sent.length, 1);
  // a second restart finds nothing to do and a repeated resume sends nothing more
  assert.deepEqual(stuckJobs([m]), []);
  const r2 = runner();
  r2.run('m1', { resume: true });
  await r2.whenIdle();
  assert.equal(sent.length, 1, 'never emailed twice');
});

await test('died while emailing: the minutes are kept and only the email is sent', async () => {
  seed({ mom: '## Summary\nShip on Friday.', decided: true, job: { state: 'emailing', beat: 1 } });
  calls = 0;
  const r = runner();
  r.run('m1', { resume: true });
  await r.whenIdle();
  assert.equal(calls, 0, 'the minutes were not written again');
  assert.equal(sent.length, 1);
  assert.equal((await getMeeting('m1')).job.state, 'done');
});

await test('died between "sending" and "sent": no second email, the person is told', async () => {
  seed({ mom: '## Summary\nx', decided: true, emailSending: Date.now() - 90000, job: { state: 'emailing', beat: 1 } });
  const r = runner();
  r.run('m1', { resume: true });
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.equal(sent.length, 0);
  assert.equal(m.job.state, 'failed');
  assert.match(m.job.error, /may already have been sent/);
});

await test('touching the page during the countdown holds the job until Write minutes is pressed', async () => {
  seed();
  calls = 0;
  const r = runner({ countdownMs: 5000 });
  r.run('m1');
  await new Promise((res) => setTimeout(res, 30));
  assert.equal((await getMeeting('m1')).job.state, 'queued');
  assert.ok((await getMeeting('m1')).job.countdownEnd > Date.now());
  r.hold('m1');
  await r.whenIdle();
  const held = await getMeeting('m1');
  assert.deepEqual([held.job.state, held.job.held, calls, sent.length], ['queued', true, 0, 0]);
  assert.deepEqual(stuckJobs([{ ...held, job: { ...held.job, beat: 1 } }]), [], 'a held job is not picked up on restart');
  r.run('m1', { force: true });
  await r.whenIdle();
  const done = await getMeeting('m1');
  assert.deepEqual([done.job.state, calls, sent.length], ['done', 1, 1]);
});

await test('a regenerate never emails again, and a failure is recorded on the meeting', async () => {
  seed({ emailedAt: Date.now(), emailedTo: 'me@x.com', mom: 'old', decided: true });
  const r = runner();
  r.run('m1', { force: true });
  await r.whenIdle();
  assert.equal(sent.length, 0);
  const bad = runner({ generate: async () => { throw Object.assign(new Error('Model said no'), { status: 400 }); } });
  bad.run('m1', { force: true });
  await bad.whenIdle();
  const m = await getMeeting('m1');
  assert.deepEqual([m.job.state, m.job.error], ['failed', 'Model said no']);
  assert.equal(isActive(m), false);
});

await test('only jobs that are active, not held and without a recent beat are resumed', () => {
  const now = 1_000_000;
  const mk = (id, job) => ({ id, job });
  const ids = stuckJobs([
    mk('a', { state: 'writing', beat: now - 60000 }),
    mk('b', { state: 'writing', beat: now - 5000 }),
    mk('c', { state: 'done', beat: 1 }),
    mk('d', { state: 'queued', held: true, beat: 1 }),
    mk('e', { state: 'emailing' }),
    mk('f', undefined),
    mk('g', { state: 'failed', beat: 1 }),
  ], now);
  assert.deepEqual(ids, ['a', 'e']);
});

console.log(`\n${passed} passed`);
