// Meeting types: matching a meeting to a type, the "Updates by person" call, and both minutes formats carrying the table.
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/store.js';
import * as A from '../src/amnex.js';
import * as T from '../src/meetingtypes.js';
import * as P from '../src/prompt.js';
import { writeMinutes } from '../src/minutes.js';

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

const at = (d, h, mi) => new Date(2026, 10, d, h, mi).getTime();
const meeting = { id: 'm1', title: 'KERALA UR - Cadence Call', url: 'https://meet.google.com/abc-defg-hij', startedAt: at(2, 10, 0), endedAt: at(2, 10, 47), invited: [], segments: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, src: 'others', text: `status item ${i} `.repeat(60) })) };
const presence = { 'Amal Samad': [0, 2800, 9], 'Shrawin Sisodia': [0, 2800, 9], 'Akhil Azad': [80, 2800, 9], 'Darshika Patel': [190, 1600, 9] };

// ---------------- matching ----------------
await test('normalize: ids are unique, columns capped and defaulted, empty types dropped', () => {
  const list = T.normalizeTypes([{ name: 'Cadence', match: 'cadence call,  stand-up', columns: ['Yesterday', 'Today', 'yesterday', 'Blockers', 'A', 'B', 'C'] }, { name: 'Cadence', match: 'x' }, {}, null, { name: 'No cols', match: 'q' }]);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((t) => t.id), ['cadence', 'cadence-2', 'no-cols']);
  assert.deepEqual(list[0].columns, ['Yesterday', 'Today', 'Blockers', 'A', 'B']);
  assert.deepEqual(list[2].columns, T.DEFAULT_COLUMNS);
  assert.equal(list[0].match, 'cadence call, stand-up');
  assert.equal(list[0].updates, true);
});

await test('match: title words (any, case ignored) or the Meet code; the first type that fits wins', () => {
  const types = T.normalizeTypes([{ name: 'Kerala', match: 'cadence call, daily stand-up' }, { name: 'Room', code: 'abc-defg-hij' }, { name: 'Other', match: 'budget' }]);
  assert.equal(T.matchType(types, { title: 'kerala ur - CADENCE CALL' })?.name, 'Kerala');
  assert.equal(T.matchType(types, { title: 'Daily Stand-Up' })?.name, 'Kerala');
  assert.equal(T.matchType(types, { title: 'Untitled', url: 'https://meet.google.com/abc-defg-hij?authuser=1' })?.name, 'Room');
  assert.equal(T.matchType(types, { title: 'Budget review' })?.name, 'Other');
  assert.equal(T.matchType(types, { title: 'Lunch' }), null);
  assert.equal(T.matchType([], { title: 'x' }), null);
});

await test('pick: the meeting\'s own choice beats matching; "" means none; an unknown id means none', () => {
  const raw = [{ name: 'Kerala', match: 'cadence' }, { name: 'Other', match: 'zzz' }];
  assert.equal(T.pickType(raw, meeting)?.id, 'kerala');
  assert.equal(T.pickType(raw, { ...meeting, typeId: 'other' })?.id, 'other');
  assert.equal(T.pickType(raw, { ...meeting, typeId: '' }), null);
  assert.equal(T.pickType(raw, { ...meeting, typeId: 'gone' }), null);
  assert.equal(T.pickType(undefined, meeting), null);
});

// ---------------- the table ----------------
await test('parse: a model table becomes rows with exactly the columns; header, separator and chatter are ignored', () => {
  const cols = ['Yesterday', 'Today', 'Blockers'];
  const rows = T.parseUpdates('Here you go:\n| Person | Yesterday | Today | Blockers |\n|---|---|---|---|\n| Amal Samad | tested portal | continue testing | **none** |\n| Akhil Azad | created 4 users | No update stated |\n| Person | a | b | c |\nthanks', cols);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Amal Samad', cells: ['tested portal', 'continue testing', 'none'] });
  assert.deepEqual(rows[1].cells, ['created 4 users', 'No update stated', 'No update stated']);
  assert.deepEqual(T.parseUpdates('no table here', cols), []);
});

await test('roster: everyone present gets a row in order, matched by name; extras the model found follow', () => {
  const cols = ['Yesterday', 'Today'];
  const roster = T.rosterOf({ presence, attendees: ['Amal Samad', 'Unknown speaker', 'Me', 'Mahaveer Prajapati'] });
  assert.deepEqual(roster, ['Amal Samad', 'Shrawin Sisodia', 'Akhil Azad', 'Darshika Patel', 'Mahaveer Prajapati']);
  const rows = T.fillRoster([{ name: 'Akhil', cells: ['users', 'menus'] }, { name: 'Safeena Mol', cells: ['grafana', 'servers'] }, { name: 'Amal S.', cells: ['tests', 'tests'] }], roster, cols);
  assert.deepEqual(rows.map((r) => r.name), ['Amal Samad', 'Shrawin Sisodia', 'Akhil Azad', 'Darshika Patel', 'Mahaveer Prajapati', 'Safeena Mol']);
  assert.deepEqual(rows[0].cells, ['tests', 'tests']);
  assert.deepEqual(rows[1].cells, [T.NO_UPDATE, T.NO_UPDATE]);
  assert.deepEqual(rows[2].cells, ['users', 'menus']);
});

await test('markdown: the block goes before Action Items, else before Risks, else at the end', () => {
  const block = T.updatesMarkdown([{ name: 'Amal | S', cells: ['a|b', 'c'] }], ['Yesterday', 'Today']);
  assert.match(block, /^## Updates by person\n\| Person \| Yesterday \| Today \|\n\|---\|---\|---\|\n\| Amal \\\| S \| a\\\|b \| c \|$/);
  assert.ok(T.insertUpdates('# T\n\n## Discussion\nx\n\n## Action Items\ny', block).indexOf('Updates by person') < T.insertUpdates('# T\n\n## Discussion\nx\n\n## Action Items\ny', block).indexOf('Action Items'));
  assert.ok(T.insertUpdates('# T\n\n## Risks and Blockers\nz', block).indexOf('Updates by person') < 20);
  assert.ok(T.insertUpdates('# T\n\ntext', block).endsWith('c |'));
});

// ---------------- the pipeline ----------------
const TABLE = '| Person | Yesterday | Today | Blockers |\n|---|---|---|---|\n| Amal Samad | portal testing | continue testing | No update stated |\n| Shrawin Sisodia | bulk upload tests | close bugs | No update stated |\n| Akhil Azad | created 4 users | No update stated | No update stated |';
const STANDARD = '# KERALA UR - Cadence Call\n\n## Overview\nx\n\n## Discussion\n### Scheme\n- done\n\n## Action Items\n| # | Action | Owner | Due | Source |\n|---|---|---|---|---|\n| 1 | a | b | c | d |\n';
const AMNEX = `## Agenda
- Status

## Discussion
| Topic | Discussion / Decision Points | Responsibility |
|---|---|---|
| Scheme | Demo done. | Amnex |

## Action Items
| Action Item | Responsibility |
|---|---|
| Amnex to deploy. | Amnex |

## Next Meeting
Date and Time: Tomorrow
Location: Meet`;

function makeGen(log, { fail = false } = {}) {
  return async (system, user) => {
    log.push({ system, user });
    if (/extract facts/.test(system)) return 'NONE';
    if (/audit meeting minutes/.test(system)) return 'NONE';
    if (/record what they said under these columns/.test(system)) {
      if (fail) throw new Error('boom');
      return TABLE;
    }
    return /house template/.test(system) ? AMNEX : STANDARD;
  };
}
const type = T.normalizeTypes([{ name: 'Cadence', match: 'cadence call', extra: 'Always write names in English.' }])[0];

await test('standard minutes: the updates table is added before Action Items, extra instructions reach the writer, one extra call', async () => {
  const log = [];
  const r = await writeMinutes({ meeting: { ...meeting, presence }, settings: { ...DEFAULTS, minutesFormat: 'standard' }, notes: '', gen: makeGen(log), ctx: { meetingType: type, extraInstructions: type.extra, attendees: ['Amal Samad'] } });
  assert.match(r.mom, /## Updates by person\n\| Person \| Yesterday \| Today \| Blockers \|/);
  assert.ok(r.mom.indexOf('## Updates by person') < r.mom.indexOf('## Action Items'));
  assert.match(r.mom, /\| Darshika Patel \| No update stated \| No update stated \| No update stated \|/);
  assert.match(r.mom, /\| Akhil Azad \| created 4 users \|/);
  assert.ok(log.some((c) => /Extra instructions for this kind of meeting/.test(c.user) && /Always write names in English/.test(c.user)));
  assert.equal(log.filter((c) => /record what they said under these columns/.test(c.system)).length, 1);
  const upd = log.find((c) => /record what they said/.test(c.system));
  assert.match(upd.user, /Roster \(people present, in this order\): Amal Samad; Shrawin Sisodia; Akhil Azad; Darshika Patel/);
});

await test('a meeting with no type gets no table and no extra call', async () => {
  const log = [];
  const r = await writeMinutes({ meeting: { ...meeting, presence }, settings: { ...DEFAULTS, minutesFormat: 'standard' }, notes: '', gen: makeGen(log), ctx: {} });
  assert.doesNotMatch(r.mom, /Updates by person/);
  assert.ok(!log.some((c) => /record what they said/.test(c.system)));
});

await test('if the updates call fails the minutes still come out, with a note to rewrite', async () => {
  const r = await writeMinutes({ meeting: { ...meeting, presence }, settings: { ...DEFAULTS, minutesFormat: 'standard' }, notes: '', gen: makeGen([], { fail: true }), ctx: { meetingType: type } });
  assert.doesNotMatch(r.mom, /## Updates by person/);
  assert.match(r.mom, /updates by person could not be written/);
  assert.match(r.mom, /## Action Items/);
});

await test('official format: the table is stored, parsed back and rendered in the document', async () => {
  const settings = { ...DEFAULTS, ...A.AMNEX_PRESET, minutesFormat: 'amnex', myName: 'Shrawin Sisodia' };
  A.setOrg(settings);
  const r = await writeMinutes({ meeting: { ...meeting, presence }, settings, notes: '', gen: makeGen([]), ctx: { meetingType: type } });
  assert.equal(r.format, 'amnex');
  assert.match(r.mom, /## Updates by person\n\| SR \| Name \| Yesterday \| Today \| Blockers \|/);
  assert.ok(r.mom.indexOf('## Updates by person') < r.mom.indexOf('## Action Items'));
  const doc = A.parseAmnexMarkdown(r.mom);
  assert.deepEqual(doc.updates.columns, ['Yesterday', 'Today', 'Blockers']);
  assert.equal(doc.updates.rows.length, 4);
  assert.deepEqual(doc.updates.rows[0], { name: 'Amal Samad', cells: ['portal testing', 'continue testing', 'No update stated'] });
  const html = A.renderDocBody(doc);
  assert.match(html, /Yesterday/);
  assert.match(html, /created 4 users/);
  assert.ok(html.indexOf('created 4 users') < html.indexOf('Action Item'));
  // without a type the document has no table and renders as before
  const plain = A.parseAmnexMarkdown((await writeMinutes({ meeting: { ...meeting, presence }, settings, notes: '', gen: makeGen([]), ctx: {} })).mom);
  assert.equal(plain.updates.rows.length, 0);
  assert.doesNotMatch(A.renderDocBody(plain), /Yesterday/);
});

await test('prompt: no extra block unless the type has instructions', () => {
  assert.doesNotMatch(P.buildUserPrompt(meeting, DEFAULTS, '', {}), /Extra instructions/);
  assert.match(P.buildUserPrompt(meeting, DEFAULTS, '', { extraInstructions: ' List leave. ' }), /Extra instructions for this kind of meeting[^\n]*\nList leave\./);
});

console.log(`\n${passed} passed`);
