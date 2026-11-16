// The pure logic behind the minutes page extras and the Open actions page (src/actionslogic.js): matching the action table to
// the items, time references, the stretch to read again and swapping its lines, notes about the shared screen, grouping,
// sorting, filtering, counts and file names. No DOM, no storage.
import assert from 'node:assert/strict';
import * as L from '../src/actionslogic.js';
import { renderMinutes } from '../src/structured.js';
import { formatTranscript } from '../src/prompt.js';

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

// the cells of a rendered Markdown table, the way the page reads them from the DOM
const tableOf = (md, heading = 'Action Items') => {
  const rows = md.split('\n').filter((l) => /^\|/.test(l) && !/^\|[-| ]+\|$/.test(l)).slice(1);
  return { heading, rows: rows.map((l) => l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())) };
};
const items = {
  overview: 'x', summary: [], topics: [], decisions: [{ text: 'Ship', at: '12:40' }], risks: [], questions: [], next: [],
  actions: [
    { id: 'a1', text: 'Run the *load* test', owner: 'Amal', due: 'Thursday', at: '13:05', quote: 'run it', status: 'open' },
    { id: 'a2', text: 'Send the budget | v2', owner: 'Priya', due: 'Not stated', at: '', quote: '', status: 'done' },
    { id: 'a3', text: '<img src=x onerror=window.__x=1>', owner: 'Team', due: 'Not stated', at: '14:10', quote: '', status: 'open' },
  ],
};
const md = renderMinutes(items, { meeting: { title: 'T', startedAt: 1e12 } });

await test('the rows of the minutes match the items, in order, even with Markdown marks, an escaped bar and a "(done)" suffix', () => {
  const t = tableOf(md);
  t.rows[0][1] = 'Run the load test'; // what a browser shows once *load* is emphasis
  const hit = L.matchActionTable([{ heading: 'Decisions', rows: [['x']] }, t], items.actions);
  assert.deepEqual(hit, { table: 1, col: 1 });
});

await test('minutes edited by hand: a changed, removed or reordered row means no match (no tick boxes rather than wrong ones)', () => {
  const t = tableOf(md);
  const edit = (fn) => { const c = JSON.parse(JSON.stringify(t)); fn(c); return L.matchActionTable([c], items.actions); };
  assert.equal(edit((c) => (c.rows[0][1] = 'Run the performance test')), null);
  assert.equal(edit((c) => c.rows.pop()), null);
  assert.equal(edit((c) => c.rows.reverse()), null);
  assert.equal(edit((c) => c.rows.push(['4', 'Another', 'X', 'Y', '-'])), null);
  assert.equal(L.matchActionTable([t], []), null);
  assert.equal(L.matchActionTable([], items.actions), null);
});

await test('the "Previous Action Items" table is never taken for this meeting\'s actions', () => {
  const t = tableOf(md, 'Previous Action Items');
  assert.equal(L.matchActionTable([t], items.actions), null);
});

await test('counts of open and done actions', () => {
  assert.deepEqual(L.actionCounts(items.actions), { open: 2, done: 1 });
  assert.deepEqual(L.actionCounts(undefined), { open: 0, done: 0 });
});

await test('time references: [mm:ss] and [h:mm:ss] are found with their place and second; look-alikes are not', () => {
  const t = L.timeTokens('Ship it [12:40] and "quote" [1:05:30]. Not [99:99] or [12] or (12:40) or [1:2].');
  assert.deepEqual(t.map((x) => [x.label, x.sec, x.index, x.length]), [['12:40', 760, 8, 7], ['1:05:30', 3930, 28, 9]]);
  assert.deepEqual(L.timeTokens(''), []);
  assert.equal(L.clockToSec('00:59'), 59);
  assert.equal(L.clockToSec('1:75:00'), null);
  assert.equal(L.clockText(3930), '1:05:30');
  assert.equal(L.clockText(65), '01:05');
});

await test('the stretch to read again: the piece (c..c+dur), else a little around the line, a gap as it is', () => {
  assert.deepEqual(L.rereadSpan({ t: 33, c: 30, dur: 30 }), [30, 60]);
  assert.deepEqual(L.rereadSpan({ t: 100 }), [95, 140]);
  assert.deepEqual(L.rereadSpan({ t: 2 }), [0, 42]);
  assert.deepEqual(L.rereadSpan({ t: 0, gap: { from: 1247, to: 1461 } }), [1247, 1461]);
  assert.deepEqual(L.splitSpan(0, 150, 60), [[0, 60], [60, 120], [120, 150]]);
  assert.deepEqual(L.splitSpan(10, 40, 60), [[10, 40]]);
});

const segs = [
  { t: 3, c: 0, dur: 30, src: 'others', text: 'one' },
  { t: 12, c: 0, dur: 30, src: 'others', text: 'two' },
  { t: 33, c: 30, dur: 30, src: 'others', text: 'three' },
  { t: 40, c: 30, dur: 30, src: 'me', text: 'mine' },
  { t: 64.9, c: 60, dur: 30, src: 'others', text: 'four' },
  { t: 90, c: 90, dur: 30, src: 'others', text: 'five' },
];

await test('replacing a stretch swaps exactly the lines inside it and keeps every other line, in order', () => {
  const fresh = L.freshLines({ text: 'new text', from: 30, to: 60, old: L.linesInSpan(segs, 30, 60) });
  const next = L.replaceLines(segs, 30, 60, fresh);
  assert.deepEqual(next.map((s) => s.text), ['one', 'two', 'new text', 'four', 'five']);
  assert.equal(segs.length, 6, 'the original list is not changed');
  assert.ok(next.find((s) => s.text === 'new text').reread);
  assert.equal(next.find((s) => s.text === 'new text').c, 30);
});

await test('a line at the very end of a piece, or the first line of the next, is not swapped by mistake', () => {
  assert.deepEqual(L.linesInSpan(segs, 0, 30).map((s) => s.text), ['one', 'two']);
  assert.deepEqual(L.linesInSpan(segs, 30, 60).map((s) => s.text), ['three', 'mine']);
  assert.deepEqual(L.linesInSpan([{ t: 29.95, c: 30 }, { t: 59.95, c: 60 }], 30, 60).map((s) => s.t), [29.95]);
});

await test('new lines: a single side keeps its side, a mixed piece takes the side of the old line before each new one, times come from the utterances', () => {
  const only = L.freshLines({ utterances: [{ t0: 1, t1: 4, text: 'a' }, { t0: 9, t1: 12, text: 'b' }], from: 0, to: 30, old: [segs[0], segs[1]] });
  assert.deepEqual(only.map((s) => [s.t, s.src, s.text]), [[1, 'others', 'a'], [9, 'others', 'b']]);
  const mixed = L.freshLines({ utterances: [{ t0: 1, t1: 4, text: 'a' }, { t0: 12, t1: 14, text: 'b' }], from: 30, to: 60, old: [segs[2], segs[3]] });
  assert.deepEqual(mixed.map((s) => [s.t, s.src]), [[31, 'others'], [42, 'me']]);
  assert.deepEqual(L.freshLines({ text: '  ', from: 0, to: 30, old: [] }), []);
  const lone = L.freshLines({ text: 'plain', from: 4, to: 34, old: [{ t: 5, src: 'me' }] });
  assert.deepEqual(lone.map((s) => [s.t, s.src, s.c, s.dur]), [[4, 'me', 4, 30]]);
});

await test('parts of one stretch join into one set of utterances in seconds from the start; a part without times becomes one utterance', () => {
  const u = L.mergeParts(
    [
      { at: 100, end: 160, result: { text: 'x', utterances: [{ t0: 2, t1: 5, text: 'x' }] } },
      { at: 160, end: 190, result: { text: 'no times here', utterances: null } },
      { at: 190, end: 200, result: { text: '', utterances: null } },
    ],
    100,
    (p) => p.end
  );
  assert.deepEqual(u, [{ t0: 2, t1: 5, text: 'x' }, { t0: 60, t1: 90, text: 'no times here' }]);
});

await test('recorded gaps that the new lines cover are dropped, others stay', () => {
  const gaps = [{ t: 20, dur: 15 }, { t: 100, dur: 20 }, { t: 25, dur: 60 }];
  assert.deepEqual(L.gapsOutside(gaps, 30, 60), [{ t: 100, dur: 20 }]);
  assert.deepEqual(L.gapsOutside(undefined, 0, 1), []);
});

await test('which stored segment plays a second, and what follows it (a hole of a pause is reported, not skipped)', () => {
  const kept = [{ seq: 0, t0: 0, dur: 30 }, { seq: 1, t0: 30, dur: 30 }, { seq: 2, t0: 90, dur: 30 }];
  assert.equal(L.segFor(kept, 12).seq, 0);
  assert.equal(L.segFor(kept, 30).seq, 1);
  assert.equal(L.segFor(kept, 75), null);
  assert.deepEqual(L.nextSeg(kept, kept[0]), { seg: kept[1], offset: 0 });
  assert.deepEqual(L.nextSeg(kept, kept[1]), { gap: true });
  assert.equal(L.nextSeg(kept, kept[2]), null);
  assert.deepEqual(L.nextSeg([{ seq: 0, t0: 0, dur: 30 }, { seq: 1, t0: 29.8, dur: 30 }], { seq: 0, t0: 0, dur: 30 }), { seg: { seq: 1, t0: 29.8, dur: 30 }, offset: 0.1999999999999993 });
});

await test('the row playing at a second is the last one that started at or before it', () => {
  assert.equal(L.rowIndexAt([3, 12, 33], 2), -1);
  assert.equal(L.rowIndexAt([3, 12, 33], 12), 1);
  assert.equal(L.rowIndexAt([3, 12, 33], 500), 2);
  assert.equal(L.rowIndexAt([], 5), -1);
});

const screens = [
  { t: 20, text: 'Slide: Budget 2026', presenter: 'Priya' },
  { t: 20.5, text: 'slide: budget 2026', presenter: 'Priya' },
  { t: 70, text: 'Spreadsheet with three tabs' },
  { t: 5, text: '   ' },
];

await test('screen notes: repeats and empty notes dropped, interleaved with speech by time, a note first at the same second', () => {
  assert.deepEqual(L.screenRows(screens).map((n) => [n.t, n.presenter]), [[20, 'Priya'], [70, '']]);
  const rows = L.withScreenRows(segs.map((s) => ({ t: s.t, src: s.src, text: s.text })), screens);
  assert.deepEqual(rows.map((r) => r.text), ['one', 'two', 'Slide: Budget 2026', 'three', 'mine', 'four', 'Spreadsheet with three tabs', 'five']);
  assert.equal(rows[2].src, 'screen');
  assert.equal(rows[2].presenter, 'Priya');
  assert.equal(L.withScreenRows([{ t: 20, src: 'others', text: 'x' }], [{ t: 20, text: 'n' }])[0].src, 'screen');
});

await test('the transcript file carries the screen notes as "[mm:ss] ON SCREEN (name): …" in place', () => {
  const meeting = { segments: segs, screens };
  const lines = formatTranscript(meeting, 'Amal', { screens: [] }).split('\n');
  assert.ok(!lines.some((l) => /SCREEN/.test(l)));
  const out = L.addScreenLines(lines, screens);
  const at = out.findIndex((l) => /ON SCREEN/.test(l));
  assert.equal(out[at], '[00:20] ON SCREEN (Priya): Slide: Budget 2026');
  assert.match(out[at - 1], /^\[00:12\]/);
  assert.match(out[at + 1], /^\[00:33\]/);
  assert.equal(out.at(-2), '[01:10] ON SCREEN: Spreadsheet with three tabs');
  assert.equal(out.length, lines.length + 2);
  assert.deepEqual(L.addScreenLines(['[00:01] ME: hi'], []), ['[00:01] ME: hi']);
  assert.deepEqual(L.addScreenLines([], [{ t: 3, text: 'only' }]), ['[00:03] ON SCREEN: only']);
});

await test('file names have nothing a file system dislikes, and the date', () => {
  const day = Date.UTC(2026, 9, 16, 9);
  assert.equal(L.safeFileName('Weekly sync', day, 'json'), 'Weekly sync-2026-10-16.json');
  assert.equal(L.safeFileName('Q3 / budget: "final"?', day, 'json'), 'Q3-budget-final-2026-10-16.json');
  assert.equal(L.safeFileName('', day, 'json'), 'Meeting-2026-10-16.json');
  assert.equal(L.safeFileName('..\\..\\evil', day, 'json'), 'evil-2026-10-16.json');
  assert.ok(L.safeFileName('x'.repeat(300), day, 'json').length < 100);
  assert.equal(L.safeFileName('Team', NaN, 'j son'), 'Team-undated.json');
});

// ---- the Open actions page ----
const today = new Date(2026, 10, 16); // 16 Nov 2026
const A = (o) => ({ meetingId: 'm1', title: 'Sync', date: new Date(2026, 10, 10).getTime(), id: Math.random().toString(36).slice(2), text: 'do', owner: 'Amal', due: 'Not stated', at: '', status: 'open', ...o });
const list = [
  A({ id: 'x1', text: 'Later task', owner: 'Priya', due: '2026-12-31' }),
  A({ id: 'x2', text: 'Overdue one', owner: 'Amal', due: '2026-11-01', overdue: true }),
  A({ id: 'x3', text: 'No date', owner: 'Not stated' }),
  A({ id: 'x4', text: 'Due today', owner: 'amal', due: '2026-11-16', meetingId: 'm2', title: 'Budget', date: new Date(2026, 10, 12).getTime() }),
  A({ id: 'x5', text: 'This week', owner: 'Team', due: '2026-11-20', meetingId: 'm2', title: 'Budget', date: new Date(2026, 10, 12).getTime() }),
  A({ id: 'x6', text: 'Overdue older', owner: 'Priya', due: '2026-10-01', overdue: true, meetingId: 'm0', title: 'Old', date: new Date(2026, 9, 2).getTime() }),
];

await test('sorting: overdue first, then the earliest due date, then dates that are not dates, newest meeting first', () => {
  assert.deepEqual(L.sortActions(list, today).map((a) => a.id), ['x6', 'x2', 'x4', 'x5', 'x1', 'x3']);
});

await test('grouping by meeting: newest meeting first, each group sorted', () => {
  const g = L.groupActions(list, 'meeting', today);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((a) => a.id)]), [['Budget', ['x4', 'x5']], ['Sync', ['x2', 'x1', 'x3']], ['Old', ['x6']]]);
});

await test('grouping by owner: one group per person whatever the case, Team then Not stated last', () => {
  const g = L.groupActions(list, 'owner', today);
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [['Amal', 2], ['Priya', 2], ['Team', 1], ['Not stated', 1]]);
});

await test('grouping by due date: Overdue, Today, the next 7 days, Later, No date set, then Done', () => {
  const done = A({ id: 'd1', status: 'done', due: '2026-11-01', text: 'finished' });
  const g = L.groupActions([...list, done], 'due', today);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((a) => a.id)]), [['Overdue', ['x6', 'x2']], ['Today', ['x4']], ['In the next 7 days', ['x5']], ['Later', ['x1']], ['No date set', ['x3']], ['Done', ['d1']]]);
});

await test('open ones come before done ones inside a group; a done action is never overdue', () => {
  const d = A({ id: 'd2', status: 'done', due: '2026-10-01', text: 'was late' });
  assert.equal(L.isOverdue(d, today), false);
  const g = L.groupActions([d, A({ id: 'o1', due: '2026-12-01' })], 'meeting', today);
  assert.deepEqual(g[0].items.map((a) => a.id), ['o1', 'd2']);
});

await test('filtering by owner, text or meeting title; every word must be found', () => {
  assert.deepEqual(L.filterActions(list, 'amal').map((a) => a.id), ['x2', 'x4']);
  assert.deepEqual(L.filterActions(list, 'priya old').map((a) => a.id), ['x6']);
  assert.deepEqual(L.filterActions(list, 'budget this').map((a) => a.id), ['x5']);
  assert.equal(L.filterActions(list, '   ').length, list.length);
  assert.equal(L.filterActions(list, 'zzz').length, 0);
});

await test('counts: open, overdue and done', () => {
  assert.deepEqual(L.countActions(list, today), { open: 6, overdue: 2, done: 0 });
  assert.deepEqual(L.countActions([...list, A({ status: 'done' })], today), { open: 6, overdue: 2, done: 1 });
  assert.deepEqual(L.countActions([], today), { open: 0, overdue: 0, done: 0 });
});

await test('done actions of the last 30 days, newest meeting first; older ones and open ones are left out', () => {
  const metas = [
    { id: 'm1', title: 'Sync', startedAt: new Date(2026, 10, 10).getTime(), items: { actions: [{ id: 'a', text: 'ok', status: 'done', doneAt: new Date(2026, 10, 15).getTime() }, { id: 'b', text: 'open', status: 'open' }, { id: 'c', text: 'long ago', status: 'done', doneAt: new Date(2026, 8, 1).getTime() }] } },
    { id: 'm2', title: 'No ticks', startedAt: new Date(2026, 10, 1).getTime(), items: { actions: [{ id: 'd', text: 'no doneAt', status: 'done' }] } },
    { id: 'm3', title: 'Old', startedAt: new Date(2026, 5, 1).getTime(), items: { actions: [{ id: 'e', text: 'no doneAt, old meeting', status: 'done' }] } },
    { id: 'm4', title: 'No items' },
  ];
  const d = L.recentDone(metas, { today });
  assert.deepEqual(d.map((a) => [a.id, a.status]), [['a', 'done'], ['d', 'done']]);
  assert.equal(d[0].title, 'Sync');
});

console.log(`\n${passed} passed`);
