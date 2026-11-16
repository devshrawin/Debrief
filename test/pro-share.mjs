// Pro features: sharing the minutes, the relay script (v5) and the calendar lookup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS } from '../src/store.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const M = await import('../src/mailer.js');
const settings = { ...DEFAULTS, emailWebhook: 'https://script.google.com/macros/s/AKfycbx_abc-123/exec' };

let calls = [];
let responder = () => new Response(JSON.stringify({ ok: true }));
globalThis.fetch = async (url, init = {}) => {
  const req = new Request(url, init);
  calls.push({ url: String(url), req, init });
  return responder(req, calls.length);
};

await test('share: addresses are parsed, validated and de-duplicated', () => {
  assert.deepEqual(M.parseAddresses('a@x.com, B@y.org;  a@x.com\nnot-an-email <c@z.in>'), ['a@x.com', 'B@y.org', 'c@z.in']);
  assert.deepEqual(M.parseAddresses(''), []);
});

await test('share: recurring-meeting groups beat the default list', () => {
  const s = { ...DEFAULTS, shareList: 'default@x.com', shareGroups: 'Cadence Call | a@x.com, b@x.com\nData | c@x.com\nbroken line' };
  assert.deepEqual(M.parseGroups(s.shareGroups).map((g) => g.match), ['cadence call', 'data']);
  assert.deepEqual(M.recipientsFor({ title: 'KERALA UR - Cadence Call' }, s).list, ['a@x.com', 'b@x.com']);
  assert.deepEqual(M.recipientsFor({ title: 'Something else' }, s).list, ['default@x.com']);
  assert.deepEqual(M.recipientsFor({ title: 'x' }, DEFAULTS).list, []);
});

await test('share: invitee emails, and only the absent ones', () => {
  const m = { invited: [{ name: 'Amal Raj', email: 'amal@x.com' }, { name: 'Priya', email: 'p@x.com' }, { name: 'No Email' }] };
  assert.deepEqual(M.inviteeEmails(m), ['amal@x.com', 'p@x.com']);
  assert.deepEqual(M.inviteeEmails(m, { absentOnly: true, absentNames: ['Priya'] }), ['p@x.com']);
});

await test('share: the script allow-list is generated for addresses or whole domains', () => {
  assert.deepEqual(M.allowListLines(['a@x.com', 'B@y.org']), { allowed: "['a@x.com', 'B@y.org']", domains: '[]' });
  assert.deepEqual(M.allowListLines(['a@x.com', 'b@x.com', 'c@y.org'], { domains: true }), { allowed: '[]', domains: "['x.com', 'y.org']" });
  const script = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const out = M.scriptWithAllowList(script, ['a@x.com'], {});
  assert.match(out, /const ALLOWED = \['a@x\.com'\];/);
  assert.match(out, /const ALLOWED_DOMAINS = \[\];/);
  assert.match(M.scriptWithAllowList(script, ['a@x.com'], { domains: true }), /const ALLOWED_DOMAINS = \['x\.com'\];/);
});

await test('share: the relay gets to, cc, bcc and the mail; calendar lookup sends the meeting code and times', async () => {
  calls = [];
  responder = () => new Response(JSON.stringify({ ok: true, to: 'me@co.com' }));
  await M.sendMail({ subject: 's', html: 'h', text: 't', attachments: [] }, settings, { to: 'a@x.com', bcc: 'b@x.com' });
  const body = JSON.parse(await calls[0].req.text());
  assert.equal(body.to, 'a@x.com');
  assert.equal(body.bcc, 'b@x.com');
  assert.equal(body.cc, '');
  calls = [];
  responder = () => new Response(JSON.stringify({ ok: true, found: true, guests: [{ email: 'a@x.com', status: 'yes' }] }));
  const guests = await M.lookupInvitees({ title: 'Sync', url: 'https://meet.google.com/abc-defg-hij?authuser=0', startedAt: 1000, endedAt: 2000 }, settings);
  assert.equal(guests.length, 1);
  const lb = JSON.parse(await calls[0].req.text());
  assert.deepEqual([lb.action, lb.code, lb.title, lb.start, lb.end], ['invitees', 'abc-defg-hij', 'Sync', 1000, 2000]);
  responder = () => new Response(JSON.stringify({ ok: true, found: false, guests: [] }));
  assert.equal(await M.lookupInvitees({ title: 'x', startedAt: 1, endedAt: 2 }, settings), null);
});

// ---- the relay script, run against stand-ins for Google's services ----
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function loadScript(patch = (s) => s, events = []) {
  const src = patch(fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'));
  const sent = [];
  const props = {};
  const env = {
    Session: { getEffectiveUser: () => ({ getEmail: () => 'Me@Co.com' }) },
    MailApp: { sendEmail: (o) => sent.push(o), getRemainingDailyQuota: () => 100 },
    Utilities: { newBlob: (b, mime, name) => ({ b, mime, name, getAs(t) { return { ...this, mime: t, setName(n) { this.name = n; return this; } }; } }), base64Decode: (s) => s },
    ContentService: { createTextOutput: (t) => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    CalendarApp: { getDefaultCalendar: () => ({ getEvents: () => events }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => (props[k] = v), deleteProperty: (k) => delete props[k] }) },
  };
  const api = new Function(...Object.keys(env), `${src}; return { doPost, doGet, resetSecret };`)(...Object.values(env));
  const post = (o, secret = SECRET) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ secret, ...o }) } }).t);
  return { api, post, sent, props };
}

await test('script v7: owner by default, allowed people and domains only, cc/bcc, reply-to', () => {
  const { post, sent, api } = loadScript((s) => s.replace('const ALLOWED = [];', "const ALLOWED = ['team@co.com'];").replace('const ALLOWED_DOMAINS = [];', "const ALLOWED_DOMAINS = ['corp.com'];"));
  assert.equal(JSON.parse(api.doGet().t).version, 8);
  assert.equal(post({ subject: 's', html: 'h', text: 't' }).to, 'Me@Co.com');
  const r = post({ to: 'team@co.com, evil@bad.com, anyone@corp.com', cc: 'x@corp.com', bcc: 'who@else.com', subject: 's' });
  assert.equal(r.to, 'team@co.com,anyone@corp.com');
  assert.deepEqual(r.cc, ['x@corp.com']);
  assert.deepEqual(r.skipped, ['evil@bad.com', 'who@else.com']);
  const mail = sent.at(-1);
  assert.equal(mail.replyTo, 'Me@Co.com');
  assert.equal(mail.cc, 'x@corp.com');
  assert.equal(mail.bcc, undefined);
  assert.equal(post({ to: 'evil@bad.com', subject: 's' }).to, 'Me@Co.com', 'a disallowed only-recipient falls back to the owner');
});

await test('script v7: bcc-only share still goes out and the owner is not forced into To', () => {
  const { post, sent } = loadScript((s) => s.replace('const ALLOWED = [];', "const ALLOWED = ['team@co.com'];"));
  const r = post({ bcc: 'team@co.com', subject: 's' });
  assert.equal(r.ok, true);
  assert.equal(sent.at(-1).bcc, 'team@co.com');
});

await test('script v7: calendar lookup finds the event by Meet code, else by title', () => {
  const guest = (email, name, status) => ({ getEmail: () => email, getName: () => name, getGuestStatus: () => status });
  const ev = (title, where, guests, startMs = Date.now()) => ({ getTitle: () => title, getLocation: () => '', getDescription: () => where, getGuestList: () => guests, getStartTime: () => ({ getTime: () => startMs }) });
  const events = [
    ev('Other', 'meet.google.com/zzz-zzzz-zzz', [guest('o@x.com', 'O', 'YES')]),
    ev('Cadence', 'Join: https://meet.google.com/abc-defg-hij', [guest('amal@co.com', 'Amal Raj', 'YES'), guest('p@co.com', '', 'NO'), guest('r@co.com', 'Ravi', 'MAYBE'), guest('q@co.com', 'Q', 'INVITED')]),
  ];
  const { post } = loadScript((s) => s, events);
  const r = post({ action: 'invitees', code: 'abc-defg-hij', title: 'x', start: Date.now(), end: Date.now() });
  assert.equal(r.found, true);
  assert.deepEqual(r.guests.map((g) => [g.email, g.status]), [['amal@co.com', 'yes'], ['p@co.com', 'no'], ['r@co.com', 'maybe'], ['q@co.com', 'invited'], ['Me@Co.com', 'owner']]);
  const byTitle = post({ action: 'invitees', code: '', title: 'cadence', start: Date.now(), end: Date.now() });
  assert.equal(byTitle.found, true);
  assert.equal(post({ action: 'invitees', code: '', title: 'nothing', start: Date.now(), end: Date.now() }).found, false);
});

await test('script v7: PDF attachments are built from HTML', () => {
  const { post, sent } = loadScript();
  post({ subject: 's', attachments: [{ name: 'MOM.pdf', fromHtml: '<h1>x</h1>' }, { name: 'a.md', mime: 'text/markdown', base64: 'abc' }] });
  const att = sent.at(-1).attachments;
  assert.equal(att[0].mime, 'application/pdf');
  assert.equal(att[0].name, 'MOM.pdf');
  assert.equal(att[1].name, 'a.md');
});

await test('script v7: locks to the first secret, refuses others, can be reset', () => {
  const { post, sent, props, api } = loadScript();
  assert.equal('locked' in JSON.parse(api.doGet().t), false, 'doGet no longer tells anyone whether the relay is locked');
  assert.equal(post({ subject: 's' }, 'short').ok, false, 'a short secret cannot claim the script');
  assert.equal(post({ subject: 's' }).ok, true, 'the first long secret claims it');
  assert.equal(props.secret?.length > 0, true, 'the first long secret was kept');
  const bad = post({ subject: 'spam', html: '<b>phish</b>' }, 'f'.repeat(32));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /locked/);
  assert.equal(sent.length, 1, 'the refused request sent nothing');
  assert.equal(post({ action: 'invitees', code: 'abc-defg-hij', start: Date.now(), end: Date.now() }, 'f'.repeat(32)).ok, false, 'the calendar lookup is locked too');
  assert.equal(post({ subject: 'again' }).ok, true);
  api.resetSecret();
  assert.equal(props.secret, undefined);
  assert.equal(post({ subject: 'new owner' }, 'f'.repeat(32)).ok, true, 'after a reset the next install can claim it');
});

await test('script v7: addresses must be exactly one clean address', () => {
  const { post } = loadScript((s) => s.replace('const ALLOWED_DOMAINS = [];', "const ALLOWED_DOMAINS = ['co.com'];"));
  const r = post({ to: 'ok@co.com, a@co.com@evil.com, "x"@co.com, <b@co.com>, c@co.com;d@co.com', subject: 's' });
  assert.equal(r.to, 'ok@co.com');
  assert.ok(r.skipped.length >= 4);
});

await test('script v7: calendar lookup needs an exact Meet code, caps the window, never returns event text, picks the nearest event', () => {
  const guest = (email, status) => ({ getEmail: () => email, getName: () => '', getGuestStatus: () => status });
  const now = Date.now();
  const ev = (title, where, guests, startMs) => ({ getTitle: () => title, getLocation: () => '', getDescription: () => where, getGuestList: () => guests, getStartTime: () => ({ getTime: () => startMs }) });
  const asked = [];
  const events = [ev('Secret board meeting', 'meet.google.com/abc-defg-hij', [guest('old@x.com', 'YES')], now - 40 * 60000), ev('Secret board meeting', 'meet.google.com/abc-defg-hij', [guest('near@x.com', 'OWNER')], now - 2 * 60000)];
  const { post } = loadScript((s) => s, events);
  assert.equal(post({ action: 'invitees', code: 'a', start: now, end: now }).found, false, 'a fragment of a code matches nothing');
  const r = post({ action: 'invitees', code: 'abc-defg-hij', start: now, end: now });
  assert.deepEqual(r.guests.map((g) => [g.email, g.status]), [['near@x.com', 'owner'], ['Me@Co.com', 'owner']]);
  assert.equal(JSON.stringify(r).includes('Secret board'), false, 'no event title leaves the script');
  assert.equal(post({ action: 'invitees', code: 'abc-defg-hij', start: -1, end: now }).found, false);
});

await test('script v7: remote resources are stripped from the PDF page', () => {
  const html = '<h1>x</h1><img src="https://evil.example/?d=1"><div style="background:url(https://evil.example/a)">y</div><link rel="stylesheet" href="https://evil.example/c.css">';
  const fn = (s) => s.replace('return out({ ok: true, to: options.to,', 'return out({ ok: true, to: options.to, stripped: stripRemote(String(d.attachments && d.attachments[0] && d.attachments[0].fromHtml || "")),');
  const { post } = loadScript(fn);
  const r = post({ subject: 's', attachments: [{ name: 'a.pdf', fromHtml: html }] });
  assert.doesNotMatch(r.stripped, /evil\.example|<img|<link/);
  assert.match(r.stripped, /<h1>x<\/h1>/);
});

await test('mailer: every relay call carries the secret, and the relay lock message is shown as is', async () => {
  calls = [];
  responder = () => new Response(JSON.stringify({ ok: true, to: 'me@x.com' }));
  await M.sendMail({ subject: 's', html: 'h', text: 't', attachments: [] }, { ...settings, emailSecret: 'z'.repeat(40) });
  assert.equal(JSON.parse(await calls[0].req.text()).secret, 'z'.repeat(40));
  responder = () => new Response(JSON.stringify({ ok: false, error: 'This script is locked to a different Debrief install.' }));
  await assert.rejects(() => M.sendMail({}, { ...settings, emailSecret: 'z'.repeat(40) }), /locked to a different Debrief install/);
});

await test('mail: company (Workspace) web app URLs with /a/macros/domain/ are accepted, test /dev URLs and http are not', async () => {
  const { mailReady } = await import('../src/mailer.js');
  const ok = (u) => mailReady({ emailWebhook: u });
  assert.ok(ok('https://script.google.com/macros/s/AKfycbx_-1/exec'));
  assert.ok(ok('https://script.google.com/a/macros/amnex.com/s/AKfycbx_-1/exec'));
  assert.ok(ok('https://script.google.com/a/amnex.com/macros/s/AKfycbx_-1/exec'));
  assert.ok(ok('  https://script.google.com/macros/s/AKfy/exec  '));
  assert.ok(!ok('https://script.google.com/macros/s/AKfy/dev'));
  assert.ok(!ok('http://script.google.com/macros/s/AKfy/exec'));
  assert.ok(!ok('https://evil.example.com/macros/s/AKfy/exec'));
  assert.ok(!ok(''));
});

await test('script v7: an event whose Meet link is not in the description is still found by its title (exact, then similar), code wins when present', () => {
  const guest = (email, name, status) => ({ getEmail: () => email, getName: () => name, getGuestStatus: () => status });
  const ev = (title, where, guests, startMs = Date.now()) => ({ getTitle: () => title, getLocation: () => '', getDescription: () => where, getGuestList: () => guests, getStartTime: () => ({ getTime: () => startMs }) });
  const events = [
    ev('Weekly review', '', [guest('w@x.com', 'W', 'YES')]),
    ev('KERALA UR - Cadence Call', 'no link here', [guest('akash@co.com', 'Akash Behera', 'YES'), guest('ankur@co.com', 'Ankur Desai', 'YES')]),
  ];
  const { post } = loadScript((s) => s, events);
  const a = post({ action: 'invitees', code: 'abc-defg-hij', title: 'KERALA UR - Cadence Call', start: Date.now(), end: Date.now() });
  assert.equal(a.found, true);
  assert.equal(a.how, 'title');
  assert.ok(a.guests.some((g) => g.email === 'akash@co.com'));
  const b = post({ action: 'invitees', code: 'abc-defg-hij', title: 'Kerala UR Cadence call (weekly)', start: Date.now(), end: Date.now() });
  assert.equal(b.found, true);
  assert.equal(b.how, 'similar title');
  assert.equal(post({ action: 'invitees', code: 'abc-defg-hij', title: 'Totally different', start: Date.now(), end: Date.now() }).found, false);
  const withCode = loadScript((s) => s, [...events, ev('Other thing', 'https://meet.google.com/abc-defg-hij', [guest('c@x.com', 'C', 'YES')])]).post({ action: 'invitees', code: 'abc-defg-hij', title: 'KERALA UR - Cadence Call', start: Date.now(), end: Date.now() });
  assert.equal(withCode.how, 'code');
  assert.ok(!('event' in withCode), 'no event text leaves the script');
});

// ---- manual sharing and the webhook ----
const { shareMinutes } = await import('../src/jobs.js');
const { webhookPayload, validWebhook, chatDigest, postWebhook, runWebhook, NO_PERMISSION } = await import('../src/webhook.js');

await test('share: manual share is not blocked but reports outsiders and whether the transcript goes to them', async () => {
  responder = () => new Response(JSON.stringify({ ok: true, to: 'a@co.com,x@other.com' }));
  const s = { ...settings, myOrgDomains: 'co.com' };
  const patches = [];
  const base = { meeting: { id: 'm', title: 'T', startedAt: 1, mom: '## x', transcriptShare: true, segments: [] }, settings: s, how: 'to', patch: async (f) => patches.push(f), ctxFor: () => ({}) };
  const r = await shareMinutes({ ...base, list: ['a@co.com', 'x@other.com'] });
  assert.deepEqual([r.external, r.transcriptToExternal], [['x@other.com'], true]);
  assert.equal(patches[0].sharedTo.length, 2, 'the outsider was sent to');
  const r2 = await shareMinutes({ ...base, meeting: { ...base.meeting, transcriptShare: false }, list: ['a@co.com', 'x@other.com'] });
  assert.deepEqual([r2.external, r2.transcriptToExternal], [['x@other.com'], false]);
  const r3 = await shareMinutes({ ...base, list: ['a@co.com'] });
  assert.deepEqual([r3.external, r3.transcriptToExternal], [[], false]);
  const r4 = await shareMinutes({ ...base, settings: { ...s, shareExternalGuard: false }, list: ['x@other.com'] });
  assert.deepEqual(r4.external, []);
});

await test('share: addresses sent by hand are no longer shown as held', async () => {
  responder = () => new Response(JSON.stringify({ ok: true, to: 'x@other.com' }));
  const patches = [];
  await shareMinutes({ meeting: { id: 'm', title: 'T', startedAt: 1, mom: '## x', shareHeld: ['x@other.com', 'y@other.com'], segments: [] }, settings, list: ['x@other.com'], how: 'to', patch: async (f) => patches.push(f), ctxFor: () => ({}) });
  assert.deepEqual(patches[0].shareHeld, ['y@other.com']);
  assert.match(patches[0].shareStatus, /y@other\.com/);
});

const MEETING = {
  id: 'm1', title: 'Sync with amal@co.com', startedAt: Date.UTC(2026, 10, 13, 10), endedAt: Date.UTC(2026, 10, 13, 10, 30), attendees: ['Amal Raj', 'Priya (priya@co.com)'], format: 'standard',
  mom: '# Sync\nAttendance: priya@co.com attended.', segments: [{ text: 'SECRET TRANSCRIPT LINE' }], voiceSegs: [[1, 2]], invited: [{ email: 'i@co.com' }],
  items: { overview: 'Shipped.', decisions: [{ text: 'Ship Friday', at: '01:00' }], actions: [{ id: 'a1', text: 'Run test', owner: 'Amal', due: 'Thu', quote: 'run the SECRET TRANSCRIPT LINE', status: 'open' }] },
};

await test('webhook: the payload has the minutes and nothing else (no transcript, email addresses, voices or keys)', () => {
  const p = webhookPayload(MEETING, { settings: { geminiKey: 'KEY123', emailSecret: 'SEC', webhookUrl: 'https://h.example/x' } });
  assert.deepEqual(Object.keys(p), ['app', 'version', 'event', 'meeting', 'items', 'minutesMarkdown']);
  assert.deepEqual([p.app, p.version, p.event], ['debrief', 1, 'minutes.written']);
  assert.deepEqual(p.meeting, { id: 'm1', title: 'Sync with [email hidden]', startedAt: MEETING.startedAt, endedAt: MEETING.endedAt, durationMin: 30, attendees: ['Amal Raj', 'Priya'], format: 'standard' });
  const text = JSON.stringify(p);
  for (const bad of ['SECRET TRANSCRIPT', 'KEY123', 'SEC"', 'i@co.com', '@co.com', 'voiceSegs', 'segments', 'quote']) assert.ok(!text.includes(bad), bad);
  assert.equal(p.items.actions[0].text, 'Run test');
  assert.equal(webhookPayload({ ...MEETING, items: undefined }).items, null);
});

await test('webhook: only https (or this computer), no credentials, not too long', () => {
  for (const ok of ['https://hooks.example.com/a?b=1', 'http://localhost:8080/x', 'http://127.0.0.1/x', 'https://x.org']) assert.equal(validWebhook(ok), true, ok);
  for (const bad of ['http://example.com/x', 'https://user:pw@example.com/x', 'https://user@example.com/x', 'ftp://x.org', 'not a url', '', undefined, `https://x.org/${'a'.repeat(2000)}`, 'http://localhost.evil.org/x']) assert.equal(validWebhook(bad), false, String(bad).slice(0, 40));
});

await test('webhook: Slack and Teams get { text } with a short digest, capped', () => {
  const d = chatDigest(MEETING);
  assert.match(d, /^Minutes: Sync with \[email hidden\] \(2026-11-13\)/);
  assert.match(d, /Decisions:\n- Ship Friday/);
  assert.match(d, /Action items:\n- Run test \(owner: Amal; due: Thu\)/);
  assert.ok(!d.includes('SECRET'));
  const big = chatDigest({ ...MEETING, items: { decisions: Array.from({ length: 400 }, (_, i) => ({ text: `decision number ${i} with some words` })) } });
  assert.ok(big.length <= 3500);
  const bodies = [];
  const f = async (url, init) => (bodies.push([url, JSON.parse(init.body)]), { status: 200 });
  return Promise.all([
    postWebhook(MEETING, { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }, { fetch: f }),
    postWebhook(MEETING, { webhookUrl: 'https://contoso.webhook.office.com/webhookb2/x' }, { fetch: f }),
    postWebhook(MEETING, { webhookUrl: 'https://outlook.office.com/webhook/x' }, { fetch: f }),
    postWebhook(MEETING, { webhookUrl: 'https://example.com/hook' }, { fetch: f }),
  ]).then(() => {
    assert.deepEqual(bodies.slice(0, 3).map(([, b]) => Object.keys(b)), [['text'], ['text'], ['text']]);
    assert.equal(bodies[3][1].event, 'minutes.written');
  });
});

await test('webhook: JSON POST, no cookies, no redirects, a timeout, and one retry after a network error or 5xx', async () => {
  const seen = [];
  const mk = (...answers) => async (url, init) => {
    seen.push(init);
    const a = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (a === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (a instanceof Error) throw a;
    return { status: a };
  };
  const S = { webhookUrl: 'https://example.com/hook' };
  const fast = { retryMs: 1, sleep: async () => {} };
  let r = await postWebhook(MEETING, S, { ...fast, fetch: mk(200) });
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].credentials, 'omit');
  assert.equal(seen[0].redirect, 'error');
  seen.length = 0;
  r = await postWebhook(MEETING, S, { ...fast, fetch: mk(503, 200) });
  assert.deepEqual([r.ok, seen.length], [true, 2]);
  seen.length = 0;
  r = await postWebhook(MEETING, S, { ...fast, fetch: mk(new TypeError('Failed to fetch'), 502) });
  assert.deepEqual([r.ok, r.status, seen.length], [false, 502, 2], 'one retry only');
  seen.length = 0;
  r = await postWebhook(MEETING, S, { ...fast, fetch: mk(400) });
  assert.deepEqual([r.ok, r.status, seen.length], [false, 400, 1], 'a 4xx is not retried');
  seen.length = 0;
  r = await postWebhook(MEETING, S, { ...fast, timeoutMs: 20, fetch: mk('hang') });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer/);
  assert.equal(seen.length, 2);
  r = await postWebhook(MEETING, { webhookUrl: 'http://evil.example/x' }, { fetch: mk(200) });
  assert.equal(r.ok, false, 'an invalid address is never called');
  assert.equal(seen.length, 2);
});

await test('webhook: runWebhook records the outcome, skips when unset, and respects a missing permission', async () => {
  const patches = [];
  const patch = async (f) => patches.push(f);
  const f = async () => ({ status: 200 });
  assert.equal(await runWebhook(MEETING, { webhookUrl: '' }, patch, { fetch: f }), null);
  assert.equal(patches.length, 0);
  const ok = await runWebhook(MEETING, { webhookUrl: 'https://example.com/h' }, patch, { fetch: f });
  assert.equal(ok.ok, true);
  assert.ok(patches[0].webhookAt && patches[0].webhookError === null);
  await runWebhook(MEETING, { webhookUrl: 'https://example.com/h' }, patch, { fetch: async () => ({ status: 404 }) });
  assert.match(patches[1].webhookError, /HTTP 404/);
  let called = 0;
  globalThis.chrome = { permissions: { contains: async ({ origins }) => (called++, assert.deepEqual(origins, ['https://example.com/*']), false) } };
  try {
    const no = await runWebhook(MEETING, { webhookUrl: 'https://example.com/h' }, patch, { fetch: async () => { throw new Error('must not be called'); } });
    assert.equal(no.error, NO_PERMISSION);
    assert.equal(patches.at(-1).webhookError, 'Debrief has no permission for this address. Open Settings and save the webhook again.');
    assert.equal(called, 1);
  } finally {
    delete globalThis.chrome;
  }
  const boom = await runWebhook(MEETING, { webhookUrl: 'https://example.com/h' }, async () => { throw new Error('store gone'); }, { fetch: f });
  assert.equal(boom.ok, false, 'never throws');
});

console.log(`\n${passed} passed`);
