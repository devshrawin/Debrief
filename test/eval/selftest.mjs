// Unit tests for the eval harness (metrics.mjs, parse.mjs) plus one offline end-to-end run. Plain node.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeText, wer, cer, scriptShare, matchItems, ownerAccuracy, dueAccuracy, timestampError } from './metrics.mjs';
import { parseMinutesItems } from './parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('normalizeText keeps Indic letters and marks, drops punctuation', () => {
  assert.equal(normalizeText('  Hello,   WORLD!! '), 'hello world');
  assert.equal(normalizeText('कल शाम तक, देख लूँगी।'), 'कल शाम तक देख लूँगी');
  assert.equal(normalizeText('ഡാറ്റ മൈഗ്രേഷൻ'), 'ഡാറ്റ മൈഗ്രേഷൻ');
  assert.equal(normalizeText("Don't stop"), 'dont stop');
  assert.equal(normalizeText('ok नमस्ते', { script: 'devanagari' }), 'नमस्ते');
});
test('wer known values', () => {
  const r = wer('the cat sat on the mat', 'the cat sit on mat');
  assert.deepEqual([r.sub, r.del, r.ins, r.refWords], [1, 1, 0, 6]);
  near(r.wer, 2 / 6);
  assert.equal(wer('a b c', 'a b c').wer, 0);
  near(wer('a b', 'a b c d').wer, 1);
  assert.equal(wer('a b', 'a b c d').ins, 2);
});
test('wer empty reference or hypothesis', () => {
  assert.equal(wer('', '').wer, 0);
  assert.equal(wer('', 'something').wer, 1);
  const r = wer('one two', '');
  assert.equal(r.wer, 1); assert.equal(r.del, 2);
  assert.equal(wer('Hello, World', 'hello world').wer, 0);
});
test('cer on Devanagari ignores spacing and flags a changed word', () => {
  assert.equal(cer('स्टैंड-अप शुरू', 'स्टैंडअप शुरू').cer, 0);
  const r = cer('देख लूँगी', 'देख लूंगी');
  assert.ok(r.cer > 0 && r.cer < 0.3, String(r.cer));
  assert.equal(cer('', '').cer, 0);
  assert.equal(cer('', 'abc').cer, 1);
});
test('scriptShare splits Latin, Devanagari, Malayalam', () => {
  const s = scriptShare('ab नमस्ते ഡാറ്റ 123');
  near(s.latin + s.devanagari + s.malayalam + s.other, 1);
  assert.ok(s.latin > 0 && s.devanagari > 0 && s.malayalam > 0 && s.other === 0);
  assert.equal(scriptShare('123 !!').letters, 0);
  assert.equal(scriptShare('hello').latin, 1);
});
test('matchItems matches, reports missed and extra', () => {
  const ref = ['Share the test cases sheet', 'Fix the payment API timeout', 'Book the venue'];
  const hyp = ['Share test cases sheet by Thursday', 'Fix payment API timeout', 'Order lunch for the team'];
  const m = matchItems(ref, hyp);
  assert.equal(m.matched.length, 2);
  assert.deepEqual(m.missed, ['Book the venue']);
  assert.deepEqual(m.extra, ['Order lunch for the team']);
  near(m.precision, 2 / 3); near(m.recall, 2 / 3); near(m.f1, 2 / 3);
});
test('matchItems handles duplicates one to one, and empties', () => {
  const m = matchItems(['send the report', 'send the report'], ['send the report']);
  assert.equal(m.matched.length, 1); assert.equal(m.missed.length, 1); assert.equal(m.recall, 0.5); assert.equal(m.precision, 1);
  const m2 = matchItems(['send the report'], ['send the report', 'send the report']);
  assert.equal(m2.extra.length, 1);
  assert.equal(matchItems([], []).f1, 1);
  assert.equal(matchItems(['x y'], []).recall, 0);
});
test('ownerAccuracy: first name, none values, missing, wrong', () => {
  const pair = (ro, ho) => ({ ref: { owner: ro }, hyp: { owner: ho } });
  const a = ownerAccuracy([pair('Amal Raj', 'amal'), pair('Priya', 'Amal'), pair('Ravi', 'Not stated'), pair('Not stated', 'Zed'), pair('', '-')]);
  assert.deepEqual([a.correct, a.wrong, a.missing, a.total], [1, 1, 1, 3]);
  near(a.accuracy, 1 / 3);
  assert.equal(ownerAccuracy([]).accuracy, null);
  assert.equal(ownerAccuracy([pair('Amal', 'Priya, Amal')]).correct, 1);
});
test('dueAccuracy compares dates loosely', () => {
  const pair = (r, h) => ({ ref: { due: r }, hyp: { due: h } });
  const d = dueAccuracy([pair('20th March', '20-Mar'), pair('Thursday', 'thursday'), pair('tomorrow evening', 'Tomorrow'), pair('Friday', 'Monday'), pair('15 April', '')]);
  assert.deepEqual([d.correct, d.wrong, d.missing], [3, 1, 1]);
});
test('timestampError mean and median', () => {
  const t = timestampError([{ ref: { at: '00:10' }, hyp: { at: '00:12' } }, { ref: { at: '1:00:00' }, hyp: { at: '59:50' } }, { ref: { at: '00:01' }, hyp: {} }, { ref: { at: '00:30' }, hyp: { at: '00:40' } }]);
  assert.equal(t.n, 3); near(t.mean, 22 / 3); assert.equal(t.median, 10);
  assert.equal(timestampError([]).mean, null);
});

const STD5 = `# Title
## Decisions
- Release moves to Monday. [12:40]
- Budget approved.

## Action Items
| # | Action | Owner | Due | Source |
|---|--------|-------|-----|--------|
| 1 | Fix the **timeout** | Priya | Tomorrow | [00:42] "kal tak timeout" |
| 2 | Share sheet | Ravi | Not stated | [01:05] "sheet share" |

## Risks and Blockers
- Vendor delay

## Open Questions / Follow-ups
- Who owns QA?
`;
test('parse standard 5-column minutes', () => {
  const p = parseMinutesItems(STD5);
  assert.equal(p.actions.length, 2);
  assert.deepEqual(p.actions[0], { text: 'Fix the timeout', owner: 'Priya', due: 'Tomorrow', at: '00:42' });
  assert.equal(p.decisions[0].text, 'Release moves to Monday.'); assert.equal(p.decisions[0].at, '12:40');
  assert.deepEqual(p.decisions[1], { text: 'Budget approved.', at: '' });
  assert.deepEqual(p.risks, ['Vendor delay']); assert.deepEqual(p.questions, ['Who owns QA?']);
});
test('parse 4-column variant', () => {
  const p = parseMinutesItems('## Action Items\n| # | Action | Owner | Due |\n|---|---|---|---|\n| 1 | Send report | Suresh | 20-Mar |');
  assert.deepEqual(p.actions, [{ text: 'Send report', owner: 'Suresh', due: '20-Mar', at: '' }]);
});
test('parse org template table, due from sentence, placeholders', () => {
  const p = parseMinutesItems('## Action Items\n| Action Item | Responsibility |\n|---|---|\n| Submit the revised budget by 16-Oct-26. | KSITM |\n| Check logs | [RESPONSIBILITY] |\n');
  assert.equal(p.actions.length, 2);
  assert.deepEqual([p.actions[0].owner, p.actions[0].due], ['KSITM', '16-Oct-26']);
  assert.equal(p.actions[1].owner, '');
  assert.equal(parseMinutesItems('## Action Items\n| Action Item | Responsibility |\n|---|---|\n| None recorded. | — |').actions.length, 0);
});
test('parse structured JSON, tolerant of missing fields', () => {
  const p = parseMinutesItems({ actions: [{ text: 'A', owner: 'X', due: 'Fri', at: '01:00' }, { text: 'B' }, 'C', {}], decisions: [{ text: 'D', at: '02:00' }, 'E'], risks: ['R'] });
  assert.equal(p.actions.length, 3); assert.equal(p.actions[1].owner, ''); assert.equal(p.actions[2].text, 'C');
  assert.deepEqual(p.decisions, [{ text: 'D', at: '02:00' }, { text: 'E', at: '' }]);
  assert.deepEqual(p.risks, ['R']); assert.deepEqual(p.questions, []);
  assert.equal(parseMinutesItems(JSON.stringify({ actions: ['Z'] })).actions[0].text, 'Z');
  assert.deepEqual(parseMinutesItems('').actions, []);
});
test('run.mjs offline on the sample set exits 0 and writes report.json', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-eval-'));
  const r = spawnSync(process.execPath, [path.join(here, 'run.mjs'), '--set', path.join(here, 'sets/sample'), '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  for (const k of ['when', 'git', 'cases', 'totals']) assert.ok(k in rep, `missing ${k}`);
  assert.equal(rep.cases.length, 2);
  assert.ok(rep.totals.wer > 0 && rep.totals.f1 > 0 && rep.totals.f1 < 1);
  const bad = spawnSync(process.execPath, [path.join(here, 'run.mjs'), '--out', out, '--fail-over-wer', '0.01'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  fs.rmSync(out, { recursive: true, force: true });
});
console.log(`\n${passed} passed`);
