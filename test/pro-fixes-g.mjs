// Regressions from audit round 3 (D1-D7): a failed IndexedDB commit settles instead of hanging Stop, an unsure share failure says
// so, an automatic share failure is recorded, the offscreen document is never closed under a starting recorder, a restored meeting
// never mails by itself, only Google's own sign-in page means "sign in", and "Completed (was pending)" is done.
// Usage: node test/pro-fixes-g.mjs
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 6).join('\n     ')}`);
    process.exitCode = 1;
  }
};
const src = (f) => readFileSync(`${SRC}/${f}`, 'utf8');
const mem = {};
const json = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 2));
const sent = [];
globalThis.chrome = {
  runtime: { sendMessage: async (m) => (sent.push(m), undefined) },
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

// ---- D1: an aborted transaction rejects; a wait on the pool has a limit ----
const AS = await import("../src/audiostore.js");
const { withTimeout } = await import("../src/timeout.js");
await test('D1 a transaction that aborts (a full disk) rejects instead of never settling', async () => {
  const r = await Promise.race([
    AS.run('readwrite', (s) => {
      s.add({ meetingId: 'm1', t: 1 });
      s.transaction.abort(); // what a failed commit does: abort, with no error event
    }).then(() => 'settled', (e) => 'rejected:' + (e?.name || e?.message)),
    new Promise((res) => setTimeout(() => res('HUNG'), 1500)),
  ]);
  assert.match(r, /^rejected/, r);
  assert.deepEqual(await AS.listPending('m1'), []); // nothing was kept
});
await test('D1 withTimeout gives up after the limit and passes a quick result through', async () => {
  const never = new Promise(() => {});
  const t0 = Date.now();
  assert.equal(await withTimeout(never, 60, 'late'), 'late');
  assert.ok(Date.now() - t0 < 600);
  assert.equal(await withTimeout(Promise.resolve('fast'), 1000, 'late'), 'fast');
});
await test('D1 the offscreen teardown waits on the pool only with a limit', () => {
  const o = src('offscreen.js');
  assert.match(o, /withTimeout\(r\.pool\?\.drain\(\), POOL_DRAIN_MS\)/);
  assert.ok(!/\n\s*await r\.pool\?\.drain\(\);/.test(o));
});

// ---- D2 / D3: what the person is told ----
const J = await import("../src/jobs.js");
await test('D2 an unsure share failure says it may already have been sent; a sure one does not', () => {
  const unsure = J.shareFailureText(Object.assign(new Error('The mail relay did not answer in 60 s.'), { unsure: true }));
  assert.match(unsure, /may already have been sent/);
  assert.match(unsure, /Check before sending again/);
  const sure = J.shareFailureText(new Error('The mail relay refused the request.'));
  assert.ok(!/already/.test(sure), sure);
  assert.match(sure, /^Share failed: /);
});
await test('D2 the minutes page uses it', () => assert.match(src('mom.js'), /shareStatus'\)\.textContent = shareFailureText\(e\)/));
await test('D3 an automatic share failure is recorded as shareStatus and notified, not swallowed', () => {
  const j = src('jobs.js');
  assert.ok(!/shareMinutes\(\{ meeting, settings, list: plan\.send[^\n]*\.catch\(\(\) => \{\}\)/.test(j), 'the silent catch is gone');
  assert.match(j, /shareFailureText\(e, 'Automatic share failed'\)/);
  assert.match(j, /patch\(\{ shareStatus: text \}\)/);
  assert.match(j, /Minutes written, not shared/);
  assert.match(J.shareFailureText(new Error('x'), 'Automatic share failed'), /^Automatic share failed: x\.$/);
});

// ---- D4: the offscreen document stays while a recorder is starting or exists ----
await test('D4 closeOffscreen is skipped while a recorder starts, and when the offscreen document reports one', () => {
  const b = src('background.js');
  assert.match(b, /async function closeOffscreen\(\{ failedStart = false \} = \{\}\)/);
  assert.match(b, /if \(starting && !failedStart\) return;/);
  assert.match(b, /busy\?\.count > 0 \|\| busy\?\.recording/);
  assert.match(b, /closeOffscreen\(\{ failedStart: true \}\)/);
  assert.match(src('offscreen.js'), /count: jobs\.count\(\), recording: !!rec/);
});

// ---- D5: a restored meeting never mails by itself ----
const S = await import("../src/store.js");
const { importAll } = await import("../src/backup.js");
await test('D5 an imported meeting is marked emailSkip; the automatic email is skipped for it, a manual one is not', async () => {
  await importAll({ app: 'debrief', version: 1, meetings: [{ id: 'm1700000000001', title: 'Old', startedAt: 5, endedAt: 9, segments: [{ t: 1, text: 'hi' }], errors: [], mom: '# minutes' }] }, { mode: 'merge' });
  assert.equal((await S.getMeeting('m1700000000001')).emailSkip, true);
  assert.match(src('jobs.js'), /!meeting\.emailedAt && !meeting\.emailSkip && meeting\.endedAt/);
  // the manual Email button goes through emailMinutes, which does not look at emailSkip
  assert.ok(!/emailSkip/.test(src('mom.js')));
});

// ---- D6: only Google's own sign-in page means "sign in" ----
const { sendMail } = await import("../src/mailer.js");
const MAIL = { emailWebhook: 'https://script.google.com/macros/s/x/exec', emailSecret: 's', emailTo: 'me@x.com' };
const reply = async (body, status = 200) => {
  globalThis.fetch = async () => new Response(body, { status });
  try {
    await sendMail({}, MAIL);
  } catch (e) {
    return e;
  }
};
await test('D6 Google sign-in page = sign in (sure); any other HTML reply with 2xx = unsure', async () => {
  const si = await reply('<html><a href="https://accounts.google.com/ServiceLogin">Sign in</a></html>');
  assert.match(si.message, /sign-in/);
  assert.ok(!si.unsure);
  const other = await reply('<html><body>Service is busy, please try later</body></html>');
  assert.ok(other.unsure, 'a stray HTML page may be the relay after it sent');
  assert.doesNotMatch(other.message, /sign-in/);
  const err = await reply('<html>Bad gateway</html>', 502);
  assert.ok(!err.unsure);
});

// ---- D7: the first word decides the action status ----
const { normStatus } = await import("../src/actions.js");
await test('D7 normStatus: the leading word decides; the old cases still hold', () => {
  assert.equal(normStatus('Completed (was pending)'), 'done');
  assert.equal(normStatus('Done, ongoing review'), 'done');
  assert.equal(normStatus('Open, was done once'), 'open');
  for (const [s, want] of [['Done', 'done'], ['Incomplete', 'open'], ['Partially done', 'open'], ['Not done', 'open'], ['not yet complete', 'open'], ['In progress', 'open'], ['Pending', 'open'], ['Resolved', 'done'], ['Not mentioned', 'not mentioned'], ['', 'not mentioned'], ['still waiting', 'open'], ['Blocked', 'open']]) assert.equal(normStatus(s), want, s);
});

// ---- E1-E7: cosmetic fixes (their looks are checked in the screenshots; these keep the rules from being dropped) ----
const ext = (f) => readFileSync(fileURLToPath(new URL(`../extension/${f}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
await test('E1 the Ask box has a short placeholder on a narrow screen', () => {
  assert.match(src('askui.js'), /opts\.placeholderNarrow \|\| 'Ask a question'/);
  assert.match(src('askpage.js'), /placeholderNarrow: 'Ask about your meetings'/);
});
await test('E2 the live page sits under the opaque top bar of the shared layout', () => {
  assert.match(ext('live.html'), /<header class="topbar">/);
  assert.match(ext('style.css'), /\.topbar \{[^}]*background: var\(--surface\)/);
});
await test('E3 a disabled button is grey with readable text, not faded', () => {
  assert.match(ext('style.css'), /\.btn:disabled, \.btn\[aria-disabled="true"\] \{ background: var\(--surface-2\); color: var\(--text-3\)/);
});
await test('E4 cards in a pair keep their own height; the quota label is short', () => {
  const o = ext('options.html');
  assert.match(ext('options.css'), /\.grid2 \{[^}]*align-items: start/);
  assert.match(o, /<label for="quotaWarnings">Warn me near a daily limit<\/label>/);
});
await test('E5 the writing state has little blank space above it and a readable label', () => {
  const m = ext('mom.css');
  assert.match(m, /#mom \.skel \{[^}]*padding-top: 4px/);
  assert.match(m, /#mom \.skel \.busy \{[^}]*color: var\(--label\)/);
});
await test('E7 date, time and serial cells of the organisation template carry a class that stops them wrapping on screen only', async () => {
  const { renderDocBody } = await import('../src/orgtemplate.js');
  const doc = { title: 'T', header: { topic: 'T', mode: 'Online', location: 'Meet', date: '18-Nov-26', time: '10:00 AM', chair: 'A' }, groups: [], agenda: [], discussion: [], actions: [{ text: 'Do it', resp: 'Ravi' }], next: { when: 'TBD', where: 'TBD' } };
  const html = renderDocBody(doc);
  assert.match(html, /<td class="amx-nw"[^>]*>(?:<b>)?18-Nov-26/);
  assert.match(html, /<td class="amx-nw"[^>]*>(?:<b>)?10:00 AM/);
  assert.match(html, /<th class="amx-nw"[^>]*>(?:<b>)?<span[^>]*>Sr\./);
  assert.match(ext('mom.css'), /@media screen and \(max-width: 600px\) \{[\s\S]*#mom \.amx \.amx-nw \{ white-space: nowrap;/);
});

// ---- F1 an unnamed voice can be removed; F2 the live page follows the shared page layout ----
await test('F1 each unnamed voice has a Remove button that asks first, deletes the voice and its clip, and leaves the transcript alone', () => {
  const m = src('mom.js');
  assert.match(m, /textContent: 'Remove', title: 'This is not a person to name/);
  assert.match(m, /title: 'Remove this voice\?'/);
  assert.match(m, /saveVoices\(\(await getVoices\(\)\)\.filter\(\(x\) => x\.id !== v\.id\)\)/);
  assert.match(m, /row\.append\(who, input, play, save, drop, excerpt\)/);
  assert.match(ext('mom.css'), /\.namerow \{ display: grid; grid-template-columns: auto 1fr auto auto auto;/);
});
await test('F2 the live page: the shared top bar, the meeting title as the page title, Open minutes in the header, transcript lines in the shared style', () => {
  const h = ext('live.html');
  assert.match(h, /<h1 id="mtitle" class="t-display lv-title"><\/h1>/);
  assert.ok(!/<h1>Live<\/h1>/.test(h), 'no second large "Live" title');
  assert.match(h, /id="chip"[\s\S]*id="minutesLink"/);
  assert.match(ext('style.css'), /\.transcript-line \{ display: grid;/);
});

console.log(`\n${passed} passed`);
