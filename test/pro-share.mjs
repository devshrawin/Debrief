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
function loadScript(patch = (s) => s, events = []) {
  const src = patch(fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'));
  const sent = [];
  const env = {
    Session: { getEffectiveUser: () => ({ getEmail: () => 'Me@Co.com' }) },
    MailApp: { sendEmail: (o) => sent.push(o), getRemainingDailyQuota: () => 100 },
    Utilities: { newBlob: (b, mime, name) => ({ b, mime, name, getAs(t) { return { ...this, mime: t, setName(n) { this.name = n; return this; } }; } }), base64Decode: (s) => s },
    ContentService: { createTextOutput: (t) => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    CalendarApp: { getDefaultCalendar: () => ({ getEvents: () => events }) },
  };
  const api = new Function(...Object.keys(env), `${src}; return { doPost, doGet };`)(...Object.values(env));
  const post = (o) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(o) } }).t);
  return { api, post, sent };
}

await test('script v5: owner by default, allowed people and domains only, cc/bcc, reply-to', () => {
  const { post, sent, api } = loadScript((s) => s.replace('const ALLOWED = [];', "const ALLOWED = ['team@co.com'];").replace('const ALLOWED_DOMAINS = [];', "const ALLOWED_DOMAINS = ['corp.com'];"));
  assert.equal(JSON.parse(api.doGet().t).version, 5);
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

await test('script v5: bcc-only share still goes out and the owner is not forced into To', () => {
  const { post, sent } = loadScript((s) => s.replace('const ALLOWED = [];', "const ALLOWED = ['team@co.com'];"));
  const r = post({ bcc: 'team@co.com', subject: 's' });
  assert.equal(r.ok, true);
  assert.equal(sent.at(-1).bcc, 'team@co.com');
});

await test('script v5: calendar lookup finds the event by Meet code, else by title', () => {
  const guest = (email, name, status) => ({ getEmail: () => email, getName: () => name, getGuestStatus: () => status });
  const ev = (title, where, guests) => ({ getTitle: () => title, getLocation: () => '', getDescription: () => where, getGuestList: () => guests });
  const events = [
    ev('Other', 'meet.google.com/zzz-zzzz-zzz', [guest('o@x.com', 'O', 'YES')]),
    ev('Cadence', 'Join: https://meet.google.com/abc-defg-hij', [guest('amal@co.com', 'Amal Raj', 'YES'), guest('p@co.com', '', 'NO'), guest('r@co.com', 'Ravi', 'MAYBE'), guest('q@co.com', 'Q', 'INVITED')]),
  ];
  const { post } = loadScript((s) => s, events);
  const r = post({ action: 'invitees', code: 'abc-defg-hij', title: 'x', start: Date.now(), end: Date.now() });
  assert.equal(r.found, true);
  assert.deepEqual(r.guests.map((g) => [g.email, g.status]), [['amal@co.com', 'yes'], ['p@co.com', 'no'], ['r@co.com', 'maybe'], ['q@co.com', 'invited'], ['Me@Co.com', 'owner']]);
  const byTitle = post({ action: 'invitees', code: 'nope-nope-nop', title: 'cadence', start: 0, end: 0 });
  assert.equal(byTitle.found, true);
  assert.equal(post({ action: 'invitees', code: 'nope-nope-nop', title: 'nothing', start: 0, end: 0 }).found, false);
});

await test('script v5: PDF attachments are built from HTML', () => {
  const { post, sent } = loadScript();
  post({ subject: 's', attachments: [{ name: 'MOM.pdf', fromHtml: '<h1>x</h1>' }, { name: 'a.md', mime: 'text/markdown', base64: 'abc' }] });
  const att = sent.at(-1).attachments;
  assert.equal(att[0].mime, 'application/pdf');
  assert.equal(att[0].name, 'MOM.pdf');
  assert.equal(att[1].name, 'a.md');
});

console.log(`\n${passed} passed`);
