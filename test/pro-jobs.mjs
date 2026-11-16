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
    hooks.length = 0;
    hookAnswer = () => ({ status: 200 });
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split("\n").slice(0, 14).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const sent = [];
const hooks = []; // webhook calls: [url, init]
let hookAnswer = () => ({ status: 200 });
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('script.google.com')) {
    hooks.push([String(url), init]);
    return hookAnswer(init);
  }
  sent.push(JSON.parse(init.body));
  return { status: 200, text: async () => JSON.stringify({ ok: true, to: String(JSON.parse(init.body).to || 'me@x.com') }) };
};

const SETTINGS = {
  llmProvider: 'gemini', geminiKey: 'k', geminiModel: 'm', minutesFormat: 'standard', minutesMode: 'quick', minutesEngine: 'classic', calendarLookup: false,
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

// ---- the external-guest guard on automatic sharing ----
const sharing = (extra = {}) => ({ ...SETTINGS, shareMode: 'auto', shareList: 'a@co.com, x@other.com, y@third.com', emailTo: 'me@co.com', ...extra });
const notes = [];

await test('guard: automatic sharing sends to the organisation, holds outsiders, and the notification only counts them', async () => {
  seed();
  mem.settings = sharing();
  notes.length = 0;
  const r = runner({ notify: (n) => notes.push(n) });
  r.run('m1');
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.equal(m.job.state, 'done');
  assert.equal(sent.length, 2, 'the email to me and one share');
  assert.equal(sent[1].to, 'a@co.com');
  assert.ok(!JSON.stringify(sent[1]).includes('other.com'));
  assert.deepEqual(m.shareHeld, ['x@other.com', 'y@third.com']);
  assert.match(m.shareStatus, /^Not sent automatically to people outside your organisation: x@other\.com, y@third\.com\. Open the minutes and press Share to send to them\.$/);
  assert.match(notes[0].message, /2 people outside your organisation/);
  assert.ok(!/@/.test(notes[0].message + notes[0].title), 'no addresses in the notification');
});

await test('guard: switched off, or the organisation unknown, everyone is sent to and nothing is held', async () => {
  for (const extra of [{ shareExternalGuard: false, myOrgDomains: 'co.com' }, { emailTo: 'me@gmail.com' }]) {
    seed();
    mem.settings = sharing(extra);
    const r = runner();
    r.run('m1');
    await r.whenIdle();
    const m = await getMeeting('m1');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].to, 'a@co.com,x@other.com,y@third.com');
    assert.equal(m.shareHeld, undefined);
    sent.length = 0;
  }
});

await test('guard: when everyone is outside, nothing is shared automatically and the job is still done', async () => {
  seed();
  mem.settings = sharing({ shareList: 'x@other.com' });
  const r = runner();
  r.run('m1');
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.deepEqual([m.job.state, sent.length, m.shareHeld], ['done', 1, ['x@other.com']]);
  assert.ok(!m.sharedAt);
});

// ---- the webhook ----
const hooked = (extra = {}) => ({ ...SETTINGS, webhookUrl: 'https://example.com/hook', ...extra });
const hookOpts = { webhook: { retryMs: 1, sleep: async () => {}, timeoutMs: 100 } };

await test('webhook: the minutes are posted once they are stored, on the first write and on a rewrite, and the time is recorded', async () => {
  seed();
  mem.settings = hooked();
  let r = runner(hookOpts);
  r.run('m1');
  await r.whenIdle();
  let m = await getMeeting('m1');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][0], 'https://example.com/hook');
  const body = JSON.parse(hooks[0][1].body);
  assert.match(body.minutesMarkdown, /Ship on Friday/);
  assert.ok(!JSON.stringify(body).includes('We agreed to ship'), 'no transcript');
  assert.ok(m.webhookAt && m.webhookError == null);
  assert.equal(m.job.state, 'done');
  r = runner(hookOpts);
  r.run('m1', { force: true });
  await r.whenIdle();
  assert.equal(hooks.length, 2);
});

await test('webhook: a failing webhook never fails the job, and the email is still sent', async () => {
  seed();
  mem.settings = hooked();
  hookAnswer = () => ({ status: 500 });
  const r = runner(hookOpts);
  r.run('m1');
  await r.whenIdle();
  const m = await getMeeting('m1');
  assert.equal(hooks.length, 2, 'one retry');
  assert.deepEqual([m.job.state, sent.length], ['done', 1]);
  assert.ok(m.emailedAt);
  assert.match(m.webhookError, /HTTP 500/);
  assert.ok(!m.webhookAt);
  hookAnswer = () => { throw new TypeError('Failed to fetch'); };
  const r2 = runner(hookOpts);
  r2.run('m1', { force: true });
  await r2.whenIdle();
  const m2 = await getMeeting('m1');
  assert.equal(m2.job.state, 'done');
  assert.match(m2.webhookError, /Could not reach the webhook/);
});

await test('webhook: not called when it is unset or invalid, nor when only the email is resumed', async () => {
  for (const url of ['', 'http://example.com/hook', 'https://u:p@example.com/h']) {
    seed();
    sent.length = 0;
    mem.settings = hooked({ webhookUrl: url });
    const r = runner(hookOpts);
    r.run('m1');
    await r.whenIdle();
    assert.equal(hooks.length, 0, url);
    assert.equal((await getMeeting('m1')).webhookError, undefined);
  }
  sent.length = 0;
  seed({ mom: '## Summary\nShip on Friday.', decided: true, job: { state: 'emailing', beat: 1 } });
  mem.settings = hooked();
  const r = runner(hookOpts);
  r.run('m1', { resume: true });
  await r.whenIdle();
  assert.deepEqual([hooks.length, sent.length], [0, 1]);
});

await test('webhook: no permission for the address means no call and a message that says what to do', async () => {
  seed();
  mem.settings = hooked();
  globalThis.chrome.permissions = { contains: async () => false };
  try {
    const r = runner(hookOpts);
    r.run('m1');
    await r.whenIdle();
  } finally {
    delete globalThis.chrome.permissions;
  }
  const m = await getMeeting('m1');
  assert.equal(hooks.length, 0);
  assert.equal(m.webhookError, 'Debrief has no permission for this address. Open Settings and save the webhook again.');
  assert.equal(m.job.state, 'done');
});

await test('webhook: a slow webhook does not hold up the email', async () => {
  seed();
  mem.settings = hooked();
  const order = [];
  hookAnswer = (init) => new Promise((res) => { order.push('hook-start'); setTimeout(() => (order.push('hook-end'), res({ status: 200 })), 60); });
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes('script.google.com')) order.push('mail'); return real(u, i); };
  try {
    const r = runner(hookOpts);
    r.run('m1');
    await r.whenIdle();
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(order, ['hook-start', 'mail', 'hook-end']);
});

console.log(`\n${passed} passed`);
