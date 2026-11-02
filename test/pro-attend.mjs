// Attendance matching for the 2 Nov Cadence Call: addresses built from a first name + initial, an initial + surname, and one
// person shown under two spellings.
import assert from 'node:assert/strict';
import { matchPeople } from '../src/attendance.js';

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

const invited = [
  { email: 'nileshg@amnex.com', status: 'invited' },
  { email: 'rkatare7005@gmail.com', status: 'yes' },
  { email: 'ravi7@amnex.com', status: 'invited' },
  { email: 'neha3@amnex.com', status: 'invited' },
  { email: 'tushar@amnex.com', status: 'invited', name: 'Tushar Galiya' },
];
const presence = { 'Nilesh Gaurda': [113, 1597, 20], 'Nilesh Gauda': [0, 1615, 3], 'Rohit Katare': [73, 1579, 15], 'Tushar Galiya': [99, 190, 4], 'Safeena Mol': [291, 2456, 8] };

await test('nileshg@ is Nilesh Gaurda and rkatare@ is Rohit Katare: both are present, not absent', () => {
  const { rows } = matchPeople(invited, presence);
  const by = (e) => rows.find((r) => r.email === e);
  assert.equal(by('nileshg@amnex.com').present?.name, 'Nilesh Gaurda');
  assert.equal(by('rkatare7005@gmail.com').present?.name, 'Rohit Katare');
  assert.equal(by('tushar@amnex.com').present?.name, 'Tushar Galiya');
  assert.equal(by('ravi7@amnex.com').present, null);
  assert.equal(by('neha3@amnex.com').present, null);
});

await test('one person under two spellings is counted once, with the span of both', () => {
  const { rows, uninvited } = matchPeople(invited, presence);
  assert.deepEqual(uninvited.map((u) => u.name), ['Safeena Mol']);
  const n = rows.find((r) => r.email === 'nileshg@amnex.com').present;
  assert.equal(n.first, 0);
  assert.equal(n.last, 1615);
});

await test('different people are not merged: another surname, or another first name', () => {
  const { uninvited } = matchPeople([], { 'Akash Jain': [0, 100, 5], 'Akash Behera': [0, 100, 5], 'Amal Samad': [0, 100, 5], 'Amal Samat': [0, 100, 5], 'Ravi Kumar': [0, 100, 5], 'Ravi Kumari': [0, 100, 5] });
  assert.deepEqual(uninvited.map((u) => u.name).sort(), ['Akash Behera', 'Akash Jain', 'Amal Samad', 'Ravi Kumar'].sort());
});

await test('a short address that only looks like a name is not matched to a stranger', () => {
  const { rows } = matchPeople([{ email: 'ravig@amnex.com', status: 'invited' }], { 'Ravi Menon': [0, 100, 5] });
  assert.equal(rows[0].present, null);
});

console.log(`\n${passed} passed`);
