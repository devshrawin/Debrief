// The mail relay (apps-script/Code.gs) run against stubs of the Google globals: with the secret embedded in the
// script, a wrong secret is refused even on a fresh relay; without it the old first-use lock still works.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as M from '../src/mailer.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok', name); };
const src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function relay(code) {
  const props = {};
  const sent = [];
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v), deleteProperty: (k) => delete props[k] }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@x.com' }) },
    MailApp: { sendEmail: (m) => sent.push(m), getRemainingDailyQuota: () => 100 },
    CalendarApp: { getDefaultCalendar: () => ({ getEvents: () => [] }) },
    Utilities: { base64Decode: () => [], newBlob: () => ({}) },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const post = (body) => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(body) } }).t);
  const get = () => JSON.parse(vm.runInContext('doGet', ctx)().t);
  return { post, get, sent, props };
}

const GOOD = 'a'.repeat(48);
const mail = (secret) => ({ secret, to: '', subject: 's', html: '<p>x</p>', text: 'x' });

await test('doGet shows only ok and the version, never whether it is locked', () => {
  const r = relay(src);
  const g = r.get();
  assert.deepEqual(Object.keys(g).sort(), ['message', 'ok', 'version']);
  assert.equal(g.version, 8);
});

await test('embedded secret: wrong secret refused on a fresh relay, right secret works, nothing is stored', () => {
  const code = M.scriptWithSecret(src, GOOD);
  assert.match(code, new RegExp(`const SECRET = '${GOOD}';`));
  const r = relay(code);
  const bad = r.post(mail('b'.repeat(48)));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /different Debrief install/);
  assert.equal(r.post(mail('short')).ok, false);
  assert.equal(r.post(mail('')).ok, false);
  assert.equal(r.sent.length, 0);
  assert.equal(r.props.secret, undefined, 'a refused caller must not become the trusted one');
  assert.notEqual(r.post(mail(GOOD)).ok, false);
});

await test('without the constant the old first-use lock still works', () => {
  const r = relay(src);
  assert.equal(r.post(mail('short')).ok, false);
  assert.notEqual(r.post(mail(GOOD)).ok, false);
  assert.equal(r.post(mail('c'.repeat(48))).ok, false);
});

await test('scriptWithAllowList embeds the secret and strips anything odd from it', () => {
  const out = M.scriptWithAllowList(src, ['a@x.com'], { secret: `${GOOD}';evil('` });
  assert.match(out, new RegExp(`const SECRET = '${GOOD}evil';`));
  assert.match(out, /const ALLOWED = \['a@x\.com'\];/);
  assert.equal(M.scriptWithSecret(src, ''), src);
});

console.log(`\n${passed} passed`);
