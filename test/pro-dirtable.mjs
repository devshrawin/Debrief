// The people directory table: text <-> rows loses nothing, the text still parses with the minutes' own reader.
import assert from 'node:assert/strict';
import { parseRows, rowsToText, parsePasted } from '../src/dirtable.js';
import { parseDirectory } from '../src/amnex.js';

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

const TEXT = '# our people\nSuresh K. | Sri. | Transport | Joint Secretary | Kochi Metro | Chair\nDana Whitfield | Ms. | Operations | Programme Director | Contoso Transit\nAlex Rivera |  |  | Project Manager | Northwind Systems';

await test('text -> rows -> text keeps every person, the chair flag and comment lines', () => {
  const { rows, notes } = parseRows(TEXT);
  assert.equal(rows.length, 3);
  assert.deepEqual(notes, ['# our people']);
  assert.equal(rows[0].chair, true);
  assert.equal(rows[2].desig, 'Project Manager');
  const back = rowsToText(rows, notes);
  assert.deepEqual(parseDirectory(back), parseDirectory(TEXT));
});

await test('rows with no name are left out; a pipe typed into a cell cannot break the line', () => {
  const t = rowsToText([{ name: '', title: '', dept: '', desig: '', org: '', chair: false }, { name: 'A | B', title: '', dept: 'X|Y', desig: '', org: '', chair: false }]);
  assert.equal(t.split('\n').length, 1);
  assert.equal(parseDirectory(t)[0].name, 'A / B');
  assert.equal(parseDirectory(t)[0].department, 'X/Y');
});

await test('pasting from a spreadsheet (tabs) or in the pipe format gives rows', () => {
  const rows = parsePasted('Suresh K.\tSri.\tTransport\tJoint Secretary\tKochi Metro\nDana\tMs.\tOps\tDirector\tContoso\tChair');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].chair, true);
  assert.equal(parsePasted('A | Mr. | D | E | F').length, 1);
});

console.log(`\n${passed} passed`);
