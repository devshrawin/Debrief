// The recipients table: the two text settings (default people, recurring-meeting lists) <-> rows, with nothing lost.
import assert from 'node:assert/strict';
import { rowsFrom, textsFrom, emailsIn } from '../src/recipients.js';

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

console.log(`\n${passed} passed`);
