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
  assert.equal(JSON.parse(api.doGet().t).version, 7);
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
  assert.equal(JSON.parse(api.doGet().t).locked, false);
  assert.equal(post({ subject: 's' }, 'short').ok, false, 'a short secret cannot claim the script');
  assert.equal(post({ subject: 's' }).ok, true, 'the first long secret claims it');
  assert.equal(JSON.parse(api.doGet().t).locked, true);
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

console.log(`\n${passed} passed`);
