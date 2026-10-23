// The structured minutes editor: Markdown -> blocks -> Markdown loses nothing, and the fields do what they say.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as A from '../src/amnex.js';
import { parseBlocks, serializeBlocks, splitRow, renumber } from '../src/mdedit.js';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
const { mountEditor } = await import('../src/mdedit.js');

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

const STANDARD = `# Pilot review

## Summary
- 6 of 8 depots are live.
  - two more by month end
- Depot 7 gets a second link.

## Action Items
| # | Action | Owner | Due |
|---|---|---|---|
| 1 | Share the plan | Ravi \\| Menon | 19-Oct |
| 2 | Take two depots live<br>and report | Priya | 30-Oct |

Some closing words
on two lines.

1. first
2. second
`;

const meeting = { id: 'm', title: 'Weekly sync', url: 'https://meet.google.com/abc-defg-hij', startedAt: new Date(2026, 9, 13, 10).getTime(), endedAt: new Date(2026, 9, 13, 11).getTime(), invited: [{ name: 'Suresh K.', email: 's@k.org' }, { name: 'Priya Nair', email: 'p@a.com' }], segments: [], errors: [] };
const facts = A.buildFacts({ meeting, settings: { myOrgDomains: 'a.com', emailTo: 'p@a.com' }, dir: A.parseDirectory('Suresh K. | Sri. | Transport | Joint Secretary | Kochi Metro | Chair'), presence: { 'Suresh K.': [1, 3000, 5], 'Priya Nair': [1, 3000, 5] } });
const known = A.knownParties({ facts, meeting, dir: [] });
const prose = A.guardProse(A.parseModelOutput('## Agenda\n- Budget.\n\n## Discussion\n| Topic | Discussion / Decision Points | Responsibility |\n|---|---|---|\n| Budget | Point one.<br>Point two with a \\| pipe. | Priya |\n\n## Action Items\n| Action Item | Responsibility |\n|---|---|\n| Send file by 16-Oct-26. | Priya |\n\n## Next Meeting\nDate and Time: TBD\nLocation: Online'), known);
const OFFICIAL = A.composeMarkdown({ facts, prose, review: ['_Written with 3 model calls._'] });

await test('standard minutes: Markdown -> blocks -> Markdown keeps every word, list, table cell, escaped pipe and line break', () => {
  const blocks = parseBlocks(STANDARD);
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'h', 'list', 'h', 'table', 'p', 'list']);
  assert.equal(blocks[2].items[1].indent, 1);
  assert.equal(blocks[4].rows[0][2], 'Ravi | Menon');
  assert.equal(blocks[4].rows[1][1], 'Take two depots live\nand report');
  assert.equal(blocks[6].ordered, true);
  const back = serializeBlocks(blocks);
  assert.deepEqual(parseBlocks(back), blocks, 'parsing the output gives the same blocks');
  for (const w of ['Ravi \\| Menon', 'live<br>and report', 'Some closing words\non two lines.', '| 2 | Take two depots live']) assert.ok(back.includes(w), w);
});

await test('official format: the stored document reads back exactly the same after a trip through the editor', () => {
  const back = serializeBlocks(parseBlocks(OFFICIAL));
  assert.ok(back.startsWith('<!-- debrief-format: amnex -->\n# Weekly sync'), 'the format marker stays first, above the title');
  assert.ok(A.isAmnexMd(back));
  assert.deepEqual(A.parseAmnexMarkdown(back), A.parseAmnexMarkdown(OFFICIAL));
});

await test('cells: escaped pipes and <br> survive; a row of the wrong width is padded, never dropped', () => {
  assert.deepEqual(splitRow('| a \\| b | c<br/>d | |'), ['a | b', 'c\nd', '']);
  const b = parseBlocks('| A | B | C |\n|---|---|---|\n| 1 | 2 |');
  assert.equal(b[0].rows[0].length, 2);
  assert.match(serializeBlocks(b), /\| 1 \| 2 \| {1,2}\|/);
});

await test('SR numbering follows the rows', () => {
  const b = parseBlocks('| SR | Action | Owner |\n|---|---|---|\n| 1 | a | x |\n| 5 | b | y |\n| 9 | c | z |')[0];
  b.rows.splice(1, 1);
  renumber(b);
  assert.deepEqual(b.rows.map((r) => r[0]), ['1', '2']);
});

const mount = (md) => {
  const root = document.getElementById('root');
  root.replaceChildren();
  const seen = [];
  const ed = mountEditor(root, md, (x) => seen.push(x));
  return { root, ed, seen, last: () => seen.at(-1) };
};
const click = (el) => el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

await test('editing in the fields: change text, remove a point, add a point, remove a table row, add a row', () => {
  const { root, ed, last } = mount(STANDARD);
  const fields = () => [...root.querySelectorAll('.ed-f')];
  // headings and points are plain fields
  type(fields().find((f) => f.value === 'Pilot review'), 'Pilot readiness review');
  assert.match(last(), /^# Pilot readiness review/);
  // remove the second point of the first list
  click(root.querySelector('.ed-list .ed-x'));
  assert.ok(!last().includes('- 6 of 8 depots are live.'));
  assert.ok(last().includes('two more by month end'));
  // add a point with the button
  click([...root.querySelectorAll('.ed-add')][0]);
  const empty = fields().find((f) => f.value === '' && f.closest('.ed-list'));
  type(empty, 'A new point');
  assert.ok(last().includes('- A new point'));
  // table: edit a cell, remove a row (and the counter column renumbers), add a row
  type(fields().find((f) => f.value === 'Priya'), 'Priya Nair');
  assert.ok(last().includes('| Priya Nair |'));
  const rowX = [...root.querySelectorAll('.ed-table .ed-x')];
  click(rowX[0]);
  assert.ok(!last().includes('Share the plan'));
  assert.match(last(), /\| 1 \| Take two depots live<br>and report \| Priya Nair \| 30-Oct \|/);
  click([...root.querySelectorAll('.ed-add')].find((b) => /row/.test(b.textContent)));
  assert.match(last(), /\| 2 \|  \|  \|  \|/);
  assert.equal(ed.getMd(), last());
});

await test('Enter adds a point below, Backspace on an empty point removes it, Undo brings it back', () => {
  const { root, ed, last } = mount('## Risks\n- one\n- two\n');
  const items = () => [...root.querySelectorAll('.ed-list .ed-f')];
  items()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(items().length, 3);
  assert.equal(items()[1].value, '');
  items()[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  assert.equal(items().length, 2);
  click(root.querySelector('.ed-list .ed-x'));
  assert.ok(!last().includes('- one'));
  assert.equal(ed.undo(), true);
  assert.ok(ed.getMd().includes('- one'), 'undo restored the removed point');
});

await test('the official format can be corrected through the editor and still parses as the official document', () => {
  const { root, last } = mount(OFFICIAL);
  assert.ok(!root.textContent.includes('debrief-format'), 'the format marker is not shown');
  const f = [...root.querySelectorAll('.ed-f')].find((x) => x.value === 'Priya Nair' && x.closest('td') && /Responsibility|Discussion/.test(x.getAttribute('aria-label') || ''));
  type(f, 'Priya Nair, Northwind');
  const doc = A.parseAmnexMarkdown(last());
  assert.ok(doc, 'still the official format');
  assert.equal(doc.discussion.length, 1);
  // remove the action item and add a wrongly missing one
  click([...root.querySelectorAll('.ed-table .ed-x')].at(-1));
  assert.equal(A.parseAmnexMarkdown(last()).actions.length, 0);
  click([...root.querySelectorAll('.ed-add')].filter((b) => /row/.test(b.textContent)).at(-1));
  const cells = [...root.querySelectorAll('.ed-table')].at(-1).querySelectorAll('tbody .ed-f');
  type(cells[0], 'Confirm the vendor supply by 19-Oct-26.');
  type(cells[1], 'Priya Nair');
  assert.equal(A.parseAmnexMarkdown(last()).actions[0].text, 'Confirm the vendor supply by 19-Oct-26.');
});

console.log(`\n${passed} passed`);
