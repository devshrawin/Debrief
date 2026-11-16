// The recipients table: the two text settings (default people, recurring-meeting lists) <-> rows, with nothing lost.
import assert from 'node:assert/strict';
import { rowsFrom, textsFrom, emailsIn } from '../src/recipients.js';
import { orgDomains, splitRecipients, guardAutoShare, shareWarning } from '../src/guard.js';

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
};

const LIST = 'priya@company.com, Ravi@Company.com;\nsam@x.org';
const GROUPS = 'Cadence Call | amal@company.com, priya@company.com\nData Discussion | deep@company.com\nbroken line without a bar';

await test('text -> rows: default people and each recurring list become rows, a broken line is ignored', () => {
  const rows = rowsFrom(LIST, GROUPS);
  assert.equal(rows.filter((r) => !r.group).length, 3);
  assert.deepEqual(rows.filter((r) => r.group === 'Cadence Call').map((r) => r.email), ['amal@company.com', 'priya@company.com']);
  assert.equal(rows.length, 6);
});

await test('rows -> text: the two settings come back in the form the sender reads', () => {
  const t = textsFrom(rowsFrom(LIST, GROUPS));
  assert.equal(t.list, 'priya@company.com, ravi@company.com, sam@x.org');
  assert.equal(t.groups, 'Cadence Call | amal@company.com, priya@company.com\nData Discussion | deep@company.com');
});

await test('half-typed or invalid addresses stay in the table but never reach the settings; duplicates are joined', () => {
  const t = textsFrom([{ email: 'priya@company', group: '' }, { email: 'a@b.co', group: '' }, { email: 'A@B.co', group: '' }, { email: 'x@y.org', group: ' ' }]);
  assert.equal(t.list, 'a@b.co, x@y.org');
});

await test('addresses are found inside pasted text', () => {
  assert.deepEqual(emailsIn('Priya <priya@company.com>; "Ravi" ravi@company.com\nPRIYA@company.com'), ['priya@company.com', 'ravi@company.com']);
});

// ---- who is outside my organisation (src/guard.js) ----
await test('guard: organisation domains come from the setting, else the company domain of "Send to", else unknown', () => {
  assert.deepEqual(orgDomains({ myOrgDomains: 'Amnex.com, @corp.in; https://x.org/path' }), ['amnex.com', 'corp.in', 'x.org']);
  assert.deepEqual(orgDomains({ myOrgDomains: '', emailTo: 'me@Company.com' }), ['company.com']);
  assert.deepEqual(orgDomains({ emailTo: 'me@gmail.com' }), [], 'a personal address says nothing about the organisation');
  assert.deepEqual(orgDomains({}), []);
  assert.deepEqual(orgDomains(undefined), []);
});
await test('guard: subdomains are inside, look-alikes are outside', () => {
  const s = { myOrgDomains: 'example.com' };
  const r = splitRecipients(['a@example.com', 'b@a.b.example.com', 'c@example.com.evil.org', 'd@notexample.com', 'e@EXAMPLE.COM', 'f@other.org'], s);
  assert.deepEqual(r.internal, ['a@example.com', 'b@a.b.example.com', 'e@EXAMPLE.COM']);
  assert.deepEqual(r.external, ['c@example.com.evil.org', 'd@notexample.com', 'f@other.org']);
  assert.equal(r.unknown, false);
});
await test('guard: with no known domains nobody is outside, and nothing is held', () => {
  const r = splitRecipients(['a@x.com', 'b@y.com'], {});
  assert.deepEqual([r.internal.length, r.external.length, r.unknown], [2, 0, true]);
  assert.deepEqual(guardAutoShare(['a@x.com'], {}), { send: ['a@x.com'], held: [], reason: '' });
  assert.equal(shareWarning(['a@x.com'], {}), '');
});
await test('guard: automatic sharing holds outsiders; switched off it sends everyone', () => {
  const s = { myOrgDomains: 'co.com', shareExternalGuard: true };
  const g = guardAutoShare(['a@co.com', 'x@other.com', 'y@third.com'], s);
  assert.deepEqual([g.send, g.held, g.reason], [['a@co.com'], ['x@other.com', 'y@third.com'], '2 people outside your organisation']);
  assert.equal(guardAutoShare(['x@other.com'], s).reason, '1 person outside your organisation');
  assert.deepEqual(guardAutoShare(['a@co.com', 'x@other.com'], { ...s, shareExternalGuard: false }), { send: ['a@co.com', 'x@other.com'], held: [], reason: '' });
  assert.deepEqual(guardAutoShare([], s), { send: [], held: [], reason: '' });
});
await test('guard: the warning for the page names the first outsider and counts the rest', () => {
  const s = { myOrgDomains: 'co.com' };
  assert.equal(shareWarning(['a@co.com', 'x@other.com'], s), 'x@other.com is outside your organisation.');
  assert.equal(shareWarning(['x@other.com', 'y@third.com'], s), 'x@other.com and 1 more are outside your organisation.');
  assert.equal(shareWarning(['x@other.com', 'y@third.com', 'z@t.com'], s), 'x@other.com and 2 more are outside your organisation.');
  assert.equal(shareWarning(['a@co.com'], s), '');
  assert.equal(shareWarning(['x@other.com'], { ...s, shareExternalGuard: false }), '');
});

console.log(`\n${passed} passed`);
