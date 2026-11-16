// Structured minutes: parsing the model's JSON, the guards, ids, rendering, the writeMinutes flow (fake model, no real
// model is called), carried action items, and the json option of the LLM providers (mocked fetch).
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/store.js';
import * as S from '../src/structured.js';
import * as X from '../src/actions.js';
import * as T from '../src/meetingtypes.js';
import * as A from '../src/orgtemplate.js';
import * as P from '../src/prompt.js';
import { writeMinutes } from '../src/minutes.js';
import { generate } from '../src/llm.js';
import { parseMinutesItems } from './eval/parse.mjs';

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

const GOOD = {
  title: 'Payment API sync',
  overview: 'The team reviewed the migration.',
  summary: ['On track'],
  topics: [{ title: 'Migration', status: 'in progress', points: ['Staging done'] }],
  decisions: [{ text: 'Ship on Friday', at: '01:10' }],
  actions: [{ text: 'Run the load test', owner: 'Amal Raj', due: 'Thursday', at: '00:10', quote: 'run the load test on staging' }],
  risks: [{ text: 'Shared test environment', at: '02:00' }],
  questions: [{ text: 'Who approves the cut-over?', at: '' }],
  next: [{ text: 'Review on Monday' }],
};
const J = (o) => JSON.stringify(o);

// ---------------- parseStructured ----------------
await test('parse: clean JSON keeps every list', () => {
  const p = S.parseStructured(J(GOOD));
  assert.equal(p.title, 'Payment API sync');
  assert.equal(p.overview, 'The team reviewed the migration.');
  assert.deepEqual(p.summary, ['On track']);
  assert.deepEqual(p.topics, [{ title: 'Migration', status: 'in progress', points: ['Staging done'] }]);
  assert.deepEqual(p.decisions, [{ text: 'Ship on Friday', at: '01:10' }]);
  assert.deepEqual(p.actions[0], { text: 'Run the load test', owner: 'Amal Raj', due: 'Thursday', at: '00:10', quote: 'run the load test on staging' });
  assert.deepEqual(p.next, [{ text: 'Review on Monday' }]);
});

await test('parse: fences, a preamble, think tags and a closing remark are cut away', () => {
  assert.equal(S.parseStructured('```json\n' + J(GOOD) + '\n```').actions.length, 1);
  assert.equal(S.parseStructured('Sure! Here are the minutes:\n' + J(GOOD) + '\nHope this helps {really}.').actions.length, 1);
  assert.equal(S.parseStructured('<think>the {user} wants JSON</think>\n' + J(GOOD)).decisions.length, 1);
  assert.equal(S.parseStructured('hidden reasoning </think>' + J(GOOD)).decisions.length, 1);
});

await test('parse: trailing commas, raw line breaks in strings, smart-quoted keys and a stray quote are repaired', () => {
  const trailing = '{"overview": "x", "actions": [{"text": "a", "owner": "Amal",}, ], "decisions": [],}';
  assert.equal(S.parseStructured(trailing).actions[0].owner, 'Amal');
  const raw = '{"overview": "line one\nline two", "actions": []}';
  assert.equal(S.parseStructured(raw).overview, 'line one line two');
  const smart = '{“overview”: "x", “actions”: [{“text”: "do it", “owner”: "Amal"}]}';
  assert.equal(S.parseStructured(smart).actions[0].text, 'do it');
  const stray = '{"overview": "He said "ship it" on Friday", "actions": []}';
  assert.match(S.parseStructured(stray).overview, /ship it/);
});

await test('parse: a reply cut off mid-way keeps what was written (open string, list and object are closed)', () => {
  const full = J(GOOD);
  const cutInString = full.slice(0, full.indexOf('"Run the load') + 12); // ... "Run the l
  const p = S.parseStructured(cutInString);
  assert.equal(p.overview, 'The team reviewed the migration.');
  assert.equal(p.decisions.length, 1);
  assert.match(p.actions[0].text, /^Run the l/);
  const cutAfterKey = full.slice(0, full.indexOf('"risks"') + 8); // ..."risks":
  assert.equal(S.parseStructured(cutAfterKey).actions.length, 1);
  const cutAtKey = full.slice(0, full.indexOf('"questions"') + 11); // a key with no colon
  assert.equal(S.parseStructured(cutAtKey).risks.length, 1);
  assert.equal(S.parseStructured('{"overview": "ok", "actions": [{"text": "a", "owner": "Am').actions[0].owner, 'Am');
});

await test('parse: key variants, numeric seconds and empty owners are normalised', () => {
  const p = S.parseStructured(J({
    Overview: 'o',
    action_items: [
      { task: 'Send the file', responsibility: 'Priya', deadline: 'Friday', timestamp: 760, evidence: '"send the file"' },
      { action: 'Book the room', assignee: '-', time: '[1:02:03]', due_date: 'n/a' },
      'Plain string action',
    ],
    key_decisions: 'ignored',
    decisions: ['Go ahead'],
    open_questions: [{ question: 'When?' }],
    next_steps: [{ text: 'Call', t: '05:00' }],
  }));
  assert.deepEqual(p.actions[0], { text: 'Send the file', owner: 'Priya', due: 'Friday', at: '12:40', quote: 'send the file' });
  assert.deepEqual([p.actions[1].owner, p.actions[1].due, p.actions[1].at], ['Not stated', 'Not stated', '1:02:03']);
  assert.deepEqual([p.actions[2].owner, p.actions[2].due, p.actions[2].at], ['Not stated', 'Not stated', '']);
  assert.deepEqual(p.decisions, [{ text: 'Go ahead', at: '' }]);
  assert.deepEqual(p.questions, [{ text: 'When?', at: '' }]);
  assert.deepEqual(p.next, [{ text: 'Call', at: '05:00' }]);
  assert.equal(S.parseStructured(J({ minutes: GOOD })).actions.length, 1, 'wrapped in an outer key');
});

await test('parse: junk, an empty object and a hollow document are null; caps hold', () => {
  for (const junk of ['', 'Sorry, I cannot help with that.', '# Minutes\n\n## Action Items\n| 1 | x |', '{}', '{"foo": 1}', '[1,2]', '{"overview": "", "summary": ["a"], "actions": [], "decisions": []}', null, undefined]) assert.equal(S.parseStructured(junk), null, String(junk));
  const big = S.parseStructured(J({ overview: 'o', decisions: Array.from({ length: 300 }, (_, i) => ({ text: `d${i}` })), actions: [{ text: 'x'.repeat(2000) }] }));
  assert.equal(big.decisions.length, 200);
  assert.ok(big.actions[0].text.length <= 600);
});

// ---------------- guardStructured ----------------
const TRANSCRIPT = [
  '[00:10] OTHERS: Amal, please run the load test on staging by Thursday.',
  '[00:40] OTHERS: Sure, main karunga. Also Priya will share the budget sheet kal tak.',
  '[01:10] OTHERS: We decided to ship the migration on Friday. See https://example.com/plan for details.',
  '[02:00] OTHERS: The test environment is shared with QA.',
  '[02:30] OTHERS: one two three four five six seven eight nine ten eleven twelve thirteen fourteen.',
].join('\n');
const guardOpts = { transcript: TRANSCRIPT, attendees: ['Amal Raj', 'Priya Nair'], absent: ['Sunil Kumar'], durationSec: 180 };
const base = (over = {}) => ({ overview: 'o', summary: [], topics: [], decisions: [], risks: [], questions: [], next: [], actions: [], ...over });

await test('guard: an invented owner is dropped but the item stays; the original is kept', () => {
  const g = S.guardStructured(base({ actions: [{ text: 'Share the budget sheet', owner: 'Rajesh Menon', due: 'kal tak', at: '00:40', quote: '' }] }), guardOpts);
  assert.equal(g.actions.length, 1);
  assert.equal(g.actions[0].owner, 'Not stated');
  assert.equal(g.actions[0].ownerDropped, 'Rajesh Menon');
});

await test('guard: an owner said next to the item is kept; an attendee first name becomes the attendee spelling; Team stays', () => {
  const g = S.guardStructured(base({ actions: [
    { text: 'Run the load test', owner: 'amal', due: 'Thursday', at: '00:10', quote: '' },
    { text: 'Share the budget sheet', owner: 'PRIYA NAIR', due: 'Not stated', at: '00:40', quote: '' },
    { text: 'Plan the demo', owner: 'Everyone', due: 'Not stated', at: '', quote: '' },
    { text: 'Check logs', owner: 'Kiran', due: 'Not stated', at: '00:10', quote: 'run the load test on staging' },
  ] }), { ...guardOpts, transcript: `${TRANSCRIPT}\n[00:12] OTHERS: Kiran, check the logs too.` });
  assert.deepEqual(g.actions.map((a) => a.owner), ['Amal Raj', 'Priya Nair', 'Team', 'Kiran']);
  assert.equal(g.actions[0].ownerDropped, undefined);
});

await test('guard: an owner who was not in the meeting is flagged; several owners are checked one by one', () => {
  const g = S.guardStructured(base({ actions: [
    { text: 'Approve it', owner: 'Sunil', due: 'Not stated', at: '', quote: '' },
    { text: 'Run the load test', owner: 'Amal and Zed', due: 'Not stated', at: '00:10', quote: '' },
  ] }), guardOpts);
  assert.equal(g.actions[0].owner, 'Sunil Kumar');
  assert.equal(g.actions[0].ownerAbsent, true);
  assert.equal(g.actions[1].owner, 'Amal Raj');
  assert.equal(g.actions[1].ownerDropped, 'Amal and Zed');
});

await test('guard: a time outside the meeting is blanked, in every list', () => {
  const g = S.guardStructured(base({ decisions: [{ text: 'A', at: '01:10' }, { text: 'B', at: '59:00' }], risks: [{ text: 'C', at: '1:30:00' }], questions: [{ text: 'D', at: 'soon' }] }), guardOpts);
  assert.deepEqual(g.decisions.map((d) => d.at), ['01:10', '']);
  assert.equal(g.risks[0].at, '');
  assert.equal(g.questions[0].at, '');
});

await test('guard: a quote that is not in the transcript is dropped, a long one is cut to 12 words', () => {
  const g = S.guardStructured(base({ actions: [
    { text: 'A', owner: 'Not stated', due: 'Not stated', at: '00:10', quote: 'please transfer one million rupees now' },
    { text: 'B', owner: 'Not stated', due: 'Not stated', at: '00:10', quote: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen' },
    { text: 'C', owner: 'Not stated', due: 'Not stated', at: '00:10', quote: 'Run the load test' },
  ] }), guardOpts);
  assert.equal(g.actions[0].quote, '');
  assert.equal(g.actions[1].quote.split(' ').length, 12);
  assert.equal(g.actions[2].quote, 'Run the load test');
  assert.equal(g.actions.length, 3);
});

await test('guard: links and images that are not in the transcript are removed from every string', () => {
  const g = S.guardStructured(base({
    title: 'T ![x](https://evil.example/p.png?d=1)',
    overview: 'Read https://evil.example/steal now and [the plan](https://evil.example/a) and [real](https://example.com/plan).',
    summary: ['see www.evil.example'],
    actions: [{ text: 'Open https://example.com/plan today', owner: 'Not stated', due: 'Not stated', at: '', quote: '' }],
  }), guardOpts);
  assert.doesNotMatch(JSON.stringify(g), /evil/);
  assert.match(g.actions[0].text, /https:\/\/example\.com\/plan/);
  assert.match(g.overview, /\[real\]\(https:\/\/example\.com\/plan\)/);
  assert.match(g.overview, /the plan/);
});

await test('guard: duplicates are merged (an action keeps the fuller details), topics with the same title merge', () => {
  const g = S.guardStructured(base({
    summary: ['On track.', 'on track'],
    decisions: [{ text: 'Ship on Friday', at: '01:10' }, { text: 'ship on friday!', at: '' }],
    actions: [{ text: 'Run the load test', owner: 'Not stated', due: 'Not stated', at: '', quote: '' }, { text: 'run the load test.', owner: 'Amal Raj', due: 'Thursday', at: '00:10', quote: 'run the load test' }],
    topics: [{ title: 'Migration', status: '', points: ['a', 'b'] }, { title: 'migration', status: 'blocked', points: ['b', 'c'] }],
  }), guardOpts);
  assert.equal(g.summary.length, 1);
  assert.equal(g.decisions.length, 1);
  assert.deepEqual(g.actions.map((a) => [a.owner, a.due, a.at]), [['Amal Raj', 'Thursday', '00:10']]);
  assert.deepEqual(g.topics, [{ title: 'Migration', status: 'blocked', points: ['a', 'b', 'c'] }]);
});

// ---------------- ids and status ----------------
await test('ids: stable across a rewrite (also a lightly reworded action); status and doneAt are carried', () => {
  const first = S.assignIds(base({ actions: [{ text: 'Run the load test on staging', owner: 'Amal', due: 'Thursday', at: '00:10', quote: '' }, { text: 'Share the budget sheet', owner: 'Priya', due: 'Not stated', at: '00:40', quote: '' }] }));
  assert.ok(first.actions.every((a) => /^a[0-9a-z]{6}$/.test(a.id) && a.status === 'open'));
  assert.notEqual(first.actions[0].id, first.actions[1].id);
  const done = { ...first, actions: first.actions.map((a, i) => (i === 0 ? { ...a, status: 'done', doneAt: 123 } : a)) };
  const again = S.assignIds(base({ actions: [
    { text: 'Share the budget sheet.', owner: 'Priya', due: 'Not stated', at: '00:40', quote: '' }, // same text, new order
    { text: 'Run the load test on the staging environment', owner: 'Amal', due: 'Thursday', at: '00:10', quote: '' }, // reworded
    { text: 'A brand new action', owner: 'Not stated', due: 'Not stated', at: '01:00', quote: '' },
  ] }), done);
  assert.equal(again.actions[0].id, first.actions[1].id);
  assert.equal(again.actions[1].id, first.actions[0].id);
  assert.deepEqual([again.actions[1].status, again.actions[1].doneAt], ['done', 123]);
  assert.equal(again.actions[0].status, 'open');
  assert.equal(again.actions[2].status, 'open');
  assert.ok(!first.actions.some((a) => a.id === again.actions[2].id));
});

// ---------------- rendering ----------------
const at = (d, h, mi) => new Date(2026, 10, d, h, mi).getTime();
const meeting = { id: 'm1', title: 'Payment API sync', url: 'https://meet.google.com/abc-defg-hij', startedAt: at(2, 10, 0), endedAt: at(2, 10, 47), invited: [], segments: [{ t: 10, src: 'others', text: 'Amal, please run the load test on staging by Thursday.' }, { t: 70, src: 'others', text: 'We decided to ship the migration on Friday.' }] };

await test('render: the structure of the classic minutes, a code-built header line, and tables the downstream parser reads back', () => {
  const items = S.assignIds(S.guardStructured(S.parseStructured(J({ ...GOOD, actions: [...GOOD.actions, { text: 'Fix | the pipe\nand the break', owner: 'Not stated', due: 'Not stated', at: '', quote: '' }] })), guardOpts));
  const md = S.renderMinutes(items, { meeting, attendees: ['Amal Raj', 'Priya Nair'] });
  assert.match(md, /^# Payment API sync\n\*\*Date:\*\* .+ · \*\*Duration:\*\* 47 min · \*\*Participants \(as identified\):\*\* Amal Raj, Priya Nair\n/);
  const order = ['## Overview', '## Summary', '## Discussion', '### Migration', '**Status:** in progress', '## Decisions', '## Action Items', '## Risks and Blockers', '## Open Questions / Follow-ups', '## Next Checkpoints'].map((h) => md.indexOf(h));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), order.join());
  assert.match(md, /- Ship on Friday \[01:10\]/);
  assert.match(md, /\| # \| Action \| Owner \| Due \| Source \|\n\|---\|--------\|-------\|-----\|--------\|\n\| 1 \| Run the load test \| Amal Raj \| Thursday \| \[00:10\] "run the load test on staging" \|/);
  assert.match(md, /Fix \\\| the pipe and the break/);
  const parsed = parseMinutesItems(md);
  assert.equal(parsed.actions.length, 2);
  assert.deepEqual([parsed.actions[0].text, parsed.actions[0].owner, parsed.actions[0].due, parsed.actions[0].at], ['Run the load test', 'Amal Raj', 'Thursday', '00:10']);
  assert.equal(parsed.actions[1].text, 'Fix \\| the pipe and the break', 'the downstream reader keeps the escape');
  assert.deepEqual(parsed.decisions, [{ text: 'Ship on Friday', at: '01:10' }]);
  assert.deepEqual(parsed.risks, ['Shared test environment']);
  assert.deepEqual(parsed.questions, ['Who approves the cut-over?']);
  // and our own reader agrees
  const back = S.itemsFromMarkdown(md);
  assert.deepEqual(back.actions.map((a) => [a.text, a.owner, a.due, a.at, a.quote]), [['Run the load test', 'Amal Raj', 'Thursday', '00:10', 'run the load test on staging'], ['Fix | the pipe and the break', 'Not stated', 'Not stated', '', '']]);
  assert.deepEqual(back.decisions, [{ text: 'Ship on Friday', at: '01:10' }]);
  assert.equal(back.topics[0].title, 'Migration');
  assert.equal(back.topics[0].status, 'in progress');
});

await test('render: empty sections are left out except Action Items; done actions say so; evidence off drops the Source column', () => {
  const md = S.renderMinutes(base({ overview: 'Only an overview.' }), { meeting });
  assert.doesNotMatch(md, /## (Summary|Discussion|Decisions|Risks|Open Questions|Next)/);
  assert.match(md, /## Action Items\n\| # \| Action \| Owner \| Due \| Source \|\n\|---\|--------\|-------\|-----\|--------\|\n\| — \| None recorded\. \| — \| — \| — \|/);
  assert.equal(parseMinutesItems(md).actions.length, 0);
  const done = S.renderMinutes(base({ actions: [{ text: 'Ship it', owner: 'Amal', due: 'Not stated', at: '', quote: '', status: 'done' }] }), { meeting, evidence: false });
  assert.match(done, /\| # \| Action \| Owner \| Due \|\n\|---\|--------\|-------\|-----\|\n\| 1 \| Ship it \(done\) \| Amal \| Not stated \|\n?$/);
});

// ---------------- writeMinutes ----------------
const lorem = (n, k = 0) => Array.from({ length: n }, (_, i) => `word${k * 100 + i}`).join(' ');
const long = { ...meeting, segments: [...meeting.segments, ...Array.from({ length: 12 }, (_, i) => ({ t: 100 + i * 20, src: 'others', text: lorem(60, i + 1) }))] };
const settings = { ...DEFAULTS, momLanguage: 'English', minutesFormat: 'standard' };
const ctx0 = { attendees: ['Amal Raj', 'Priya Nair'] };
const CLASSIC_MD = '# Payment API sync\n\n## Overview\nx\n\n## Decisions\n- Ship on Friday [01:10]\n\n## Action Items\n| # | Action | Owner | Due | Source |\n|---|--------|-------|-----|--------|\n| 1 | Run the load test | Amal Raj | Thursday | [00:10] "run the load test" |\n';

// A scripted fake model: answers by what the system prompt is about, and logs every call.
function fake(log, { json = J(GOOD), fix, check = 'NONE', classic = CLASSIC_MD, extra = {} } = {}) {
  return async (system, user, onText, opts) => {
    log.push({ system, user, opts });
    if (extra.throwOn?.test(system)) throw (extra.error || new Error('boom'));
    if (/EDITING minutes/.test(system)) return typeof fix === 'function' ? fix() : fix ?? json;
    if (/ONE JSON document/.test(system)) return typeof json === 'function' ? json(user) : json;
    if (/audit meeting minutes/.test(system)) return check;
    if (/extract facts/.test(system)) return 'ACTION | Amal Raj | Thursday | [00:10] | run the load test | "run the load test"';
    if (/record what they said under these columns/.test(system)) return '| Person | Yesterday | Today | Blockers |\n|---|---|---|---|\n| Amal Raj | a | b | c |';
    return classic;
  };
}
const calls = (log, re) => log.filter((c) => re.test(c.system)).length;

await test('structured: one call (json requested), items returned with ids, Markdown from code, names normalised to the attendee list', async () => {
  const log = [];
  const r = await writeMinutes({ meeting, settings, notes: '', gen: fake(log, { json: J({ ...GOOD, actions: [{ ...GOOD.actions[0], owner: 'amal' }] }) }), ctx: ctx0 });
  assert.equal(log.length, 1);
  assert.equal(log[0].opts.json, true);
  assert.equal(log[0].opts.temperature, 0.2);
  assert.match(log[0].system, /ONE JSON document/);
  assert.match(log[0].user, /<transcript>/);
  assert.equal(r.stats.engine, 'structured');
  assert.equal(r.stats.calls, 1);
  assert.equal(r.stats.fellBack, undefined);
  assert.equal(r.items.actions[0].owner, 'Amal Raj');
  assert.match(r.items.actions[0].id, /^a/);
  assert.equal(r.items.actions[0].status, 'open');
  assert.equal(r.format, 'standard');
  assert.equal(r.extract, null);
  assert.equal(r.review, null);
  assert.match(r.mom, /\*\*Participants \(as identified\):\*\* Amal Raj, Priya Nair/);
  assert.match(r.mom, /\| 1 \| Run the load test \| Amal Raj \| Thursday \|/);
  assert.match(r.mom, /---\n\n_Written with a single pass\._$/);
});

await test('structured: a long transcript is read in one call plus the completeness check (no extraction windows for a hosted model)', async () => {
  const log = [];
  const r = await writeMinutes({ meeting: long, settings, notes: '', gen: fake(log), ctx: ctx0 });
  assert.equal(log.length, 2);
  assert.equal(calls(log, /extract facts/), 0);
  assert.equal(calls(log, /ONE JSON document/), 1);
  assert.equal(calls(log, /audit meeting minutes/), 1);
  assert.equal(r.stats.calls, 2);
  assert.match(r.mom, /Written with 2 model calls \(structured writing, completeness check\)/);
});

await test('structured: a local model (or a very long transcript) still gets the extraction windows and the checklist', async () => {
  const log = [];
  const local = { ...settings, llmProvider: 'openai', oaBase: 'http://localhost:11434/v1' };
  const r = await writeMinutes({ meeting: long, settings: local, notes: '', gen: fake(log), ctx: ctx0 });
  assert.ok(calls(log, /extract facts/) >= 1);
  const write = log.find((c) => /ONE JSON document/.test(c.system));
  assert.match(write.user, /<checklist>/);
  assert.match(write.user, /run the load test/);
  assert.ok(r.extract?.items.length >= 1);
  assert.match(r.mom, /item extraction, structured writing, completeness check/);
});

await test('structured: the completeness check adds a missing point into the JSON (one more structured call)', async () => {
  const log = [];
  const withMissing = { ...GOOD, decisions: [...GOOD.decisions, { text: 'Freeze the schema', at: '00:20' }] };
  const r = await writeMinutes({ meeting: long, settings, notes: '', gen: fake(log, { check: 'Nothing else.\n[00:20] schema freeze | "freeze"', fix: J(withMissing) }), ctx: ctx0 });
  assert.equal(r.stats.missed, 1);
  assert.equal(r.stats.merged, true);
  assert.equal(r.stats.calls, 3);
  const fixCall = log.find((c) => /EDITING minutes/.test(c.system));
  assert.match(fixCall.user, /<minutes_json>/);
  assert.match(fixCall.user, /\[00:20\] schema freeze/);
  assert.doesNotMatch(fixCall.user, /"id"|"doneAt"|"status":"open"/);
  assert.equal(fixCall.opts.json, true);
  assert.equal(r.items.decisions.length, 2);
  assert.match(r.mom, /- Freeze the schema \[00:20\]/);
  assert.doesNotMatch(r.mom, /Added by the completeness check/);
  assert.equal(r.items.actions[0].id, S.assignIds(S.guardStructured(S.parseStructured(J(GOOD)), { ...guardOpts, durationSec: 2820 })).actions[0].id, 'ids unchanged by the fix');
});

await test('structured: a fix that loses an item (or does not parse) is not accepted: the points are appended as before', async () => {
  for (const fix of [J({ ...GOOD, actions: [], decisions: [...GOOD.decisions, { text: 'Freeze the schema', at: '00:20' }] }), 'I could not do that.', J(GOOD)]) {
    const r = await writeMinutes({ meeting: long, settings, notes: '', gen: fake([], { check: '[00:20] schema freeze | "freeze"', fix }), ctx: ctx0 });
    assert.match(r.mom, /## Added by the completeness check[\s\S]*schema freeze/);
    assert.notEqual(r.stats.merged, true);
    assert.equal(r.items.actions.length, 1);
  }
});

await test('structured: unusable JSON falls back to the classic pipeline and still returns minutes and derived items', async () => {
  const log = [];
  const r = await writeMinutes({ meeting, settings, notes: '', gen: fake(log, { json: 'I am sorry, I cannot write JSON.' }), ctx: ctx0 });
  assert.equal(r.stats.fellBack, 'classic');
  assert.equal(r.stats.engine, 'classic');
  assert.equal(r.stats.calls, 2);
  assert.match(r.mom, /## Decisions\n- Ship on Friday/);
  assert.equal(r.items.actions[0].text, 'Run the load test');
  assert.equal(r.items.actions[0].owner, 'Amal Raj');
  assert.match(r.items.actions[0].id, /^a/);
  assert.match(r.mom, /Written with 2 model calls/);
  // a failing call (not an abort) falls back too
  const log2 = [];
  const r2 = await writeMinutes({ meeting, settings, notes: '', gen: fake(log2, { extra: { throwOn: /ONE JSON document/ } }), ctx: ctx0 });
  assert.equal(r2.stats.fellBack, 'classic');
  assert.match(r2.mom, /Run the load test/);
  // a long meeting falling back still runs the extraction and the audit of the classic way
  const log3 = [];
  await writeMinutes({ meeting: long, settings, notes: '', gen: fake(log3, { json: 'nope' }), ctx: ctx0 });
  assert.ok(calls(log3, /extract facts/) >= 1 && calls(log3, /audit meeting minutes/) === 1);
  assert.match(log3.find((c) => !/extract facts|audit|ONE JSON/.test(c.system)).user, /<checklist>/);
});

await test('abort always propagates, in every call', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(() => writeMinutes({ meeting, settings, notes: '', gen: fake([], { extra: { throwOn: /ONE JSON document/, error: abort } }), ctx: ctx0 }), { name: 'AbortError' });
  await assert.rejects(() => writeMinutes({ meeting: long, settings, notes: '', gen: fake([], { check: '[00:20] x | "y"', extra: { throwOn: /EDITING minutes/, error: abort } }), ctx: ctx0 }), { name: 'AbortError' });
  await assert.rejects(() => writeMinutes({ meeting, settings: { ...settings, minutesEngine: 'classic' }, notes: '', gen: fake([], { extra: { throwOn: /MOM/, error: abort } }), ctx: ctx0 }), { name: 'AbortError' });
});

await test('classic engine: today\'s calls, no JSON request, and items derived from the Markdown', async () => {
  const log = [];
  const r = await writeMinutes({ meeting: long, settings: { ...settings, minutesEngine: 'classic' }, notes: '', gen: fake(log), ctx: ctx0 });
  assert.equal(calls(log, /ONE JSON document/), 0);
  assert.ok(log.every((c) => !c.opts?.json));
  assert.ok(calls(log, /extract facts/) >= 1);
  assert.equal(calls(log, /audit meeting minutes/), 1);
  assert.equal(r.stats.engine, 'classic');
  assert.equal(r.stats.fellBack, undefined);
  assert.match(r.mom, /Written with \d+ model calls \(item extraction, writing, completeness check\)/);
  assert.deepEqual(r.items.actions.map((a) => [a.text, a.owner, a.due, a.at]), [['Run the load test', 'Amal Raj', 'Thursday', '00:10']]);
  assert.deepEqual(r.items.decisions, [{ text: 'Ship on Friday', at: '01:10' }]);
  assert.ok(r.items.actions[0].id && r.extract);
  const none = await writeMinutes({ meeting, settings: { ...settings, minutesEngine: 'classic' }, notes: '', gen: fake([], { classic: 'Just words, no sections.' }), ctx: ctx0 });
  assert.equal(none.items, null);
  assert.match(none.mom, /a single pass/);
});

await test('classic engine: the cached extraction is reused on a rewrite, as before', async () => {
  const s = { ...settings, minutesEngine: 'classic' };
  const first = await writeMinutes({ meeting: long, settings: s, notes: '', gen: fake([]), ctx: ctx0 });
  const log = [];
  const again = await writeMinutes({ meeting: { ...long, extract: first.extract }, settings: s, notes: '', gen: fake(log), ctx: ctx0 });
  assert.equal(calls(log, /extract facts/), 0);
  assert.equal(again.stats.reused, true);
});

await test('rewrite: ids and done status survive, and the done action reads "(done)"', async () => {
  const first = await writeMinutes({ meeting, settings, notes: '', gen: fake([]), ctx: ctx0 });
  const marked = X.setActionStatus(first.items, first.items.actions[0].id, 'done', 99);
  const reworded = { ...GOOD, actions: [{ ...GOOD.actions[0], text: 'Run the load test on staging' }] };
  const again = await writeMinutes({ meeting: { ...meeting, items: marked }, settings, notes: '', gen: fake([], { json: J(reworded) }), ctx: ctx0 });
  assert.equal(again.items.actions[0].id, first.items.actions[0].id);
  assert.deepEqual([again.items.actions[0].status, again.items.actions[0].doneAt], ['done', 99]);
  assert.match(again.mom, /Run the load test on staging \(done\) \|/);
});

await test('meeting type: the updates table is still inserted before Action Items, for both engines', async () => {
  const type = T.normalizeTypes([{ name: 'Cadence', match: 'sync' }])[0];
  const presence = { 'Amal Raj': [0, 2800, 9], 'Priya Nair': [0, 2800, 9] };
  for (const engine of ['structured', 'classic']) {
    const log = [];
    const r = await writeMinutes({ meeting: { ...meeting, presence }, settings: { ...settings, minutesEngine: engine }, notes: '', gen: fake(log), ctx: { ...ctx0, meetingType: type } });
    assert.match(r.mom, /## Updates by person\n\| Person \| Yesterday \| Today \| Blockers \|/, engine);
    assert.ok(r.mom.indexOf('## Updates by person') < r.mom.indexOf('## Action Items'), engine);
    assert.equal(calls(log, /record what they said/), 1);
    assert.match(r.mom, /_Written with /);
  }
});

await test('template format: the dedicated template call is kept (no JSON call) and items are read from its result', async () => {
  const org = { ...DEFAULTS, ...A.AMNEX_PRESET, minutesFormat: 'template', myName: 'Shrawin Sisodia' };
  A.setOrg(org);
  const reply = '## Agenda\n- Status\n\n## Discussion\n| Topic | Discussion / Decision Points | Responsibility |\n|---|---|---|\n| Scheme | Demo done.<br>Rollout planned. | Amnex |\n\n## Action Items\n| Action Item | Responsibility |\n|---|---|\n| Amnex to deploy the build by 16-Oct-26. | Amnex |\n| Share the notes. | [RESPONSIBILITY] |\n\n## Next Meeting\nDate and Time: Monday 10:00\nLocation: Meet';
  const log = [];
  const r = await writeMinutes({ meeting, settings: org, notes: '', gen: fake(log, { classic: reply }), ctx: {} });
  assert.equal(r.format, 'template');
  assert.equal(log.length, 1);
  assert.ok(!/ONE JSON/.test(log[0].system));
  assert.ok(A.isTemplateMd(r.mom));
  assert.equal(r.stats.engine, 'template');
  assert.deepEqual(r.items.topics, [{ title: 'Scheme', status: '', points: ['Demo done.', 'Rollout planned.'] }]);
  assert.equal(r.items.actions.length, 2);
  assert.deepEqual([r.items.actions[0].due, r.items.actions[0].owner], ['16-Oct-26', 'Amnex Infotechnologies']);
  assert.equal(r.items.actions[1].owner, 'Not stated');
  assert.deepEqual(r.items.next, [{ text: 'Next meeting: Monday 10:00, Meet' }]);
  assert.ok(r.items.actions.every((a) => a.id && a.status === 'open'));
  // a reply that does not fit the template goes on to the structured minutes
  const log2 = [];
  const r2 = await writeMinutes({ meeting, settings: org, notes: '', gen: fake(log2, { classic: 'Here are some thoughts, no tables.', json: J(GOOD) }), ctx: {} });
  assert.equal(r2.format, 'standard');
  assert.equal(r2.stats.fellBack, true);
  assert.equal(r2.items.actions[0].text, 'Run the load test');
});

// ---------------- carried action items ----------------
const carry = { prevTitle: 'Payment API sync', prevDate: '2026-10-26', open: [{ id: 'a1x', text: 'Share the budget sheet', owner: 'Priya Nair', due: 'Friday' }, { id: 'a2y', text: 'Book the venue', owner: 'Not stated', due: 'Not stated' }] };

await test('carry (structured): the previous open actions are in the prompt, the review comes back for supplied ids only, and the section is rendered', async () => {
  const log = [];
  const json = J({ ...GOOD, previous: [{ id: 'a1x', status: 'Done', note: 'sent on Monday' }, { id: 'zzz', status: 'done' }, { id: '2', status: 'still pending', note: 'no date yet' }, 'junk'] });
  const r = await writeMinutes({ meeting, settings, notes: '', gen: fake(log, { json }), ctx: { ...ctx0, carry } });
  const user = log[0].user;
  assert.match(user, /Open action items from the previous meeting in this series \(Payment API sync, 2026-10-26\)\. For each, say in the minutes whether it was reported done, is still open, or was not mentioned:/);
  assert.match(user, /1\. \[id: a1x\] Share the budget sheet \(owner: Priya Nair; due: Friday\)/);
  assert.match(user, /"previous"/);
  assert.ok(user.indexOf('Open action items') < user.indexOf('<transcript>'));
  assert.deepEqual(r.review, [{ id: 'a1x', status: 'done', note: 'sent on Monday' }, { id: 'a2y', status: 'open', note: 'no date yet' }]);
  assert.match(r.mom, /## Summary[\s\S]*## Previous Action Items\n\| # \| Action \| Owner \| Due \| Status \|\n\|---\|--------\|-------\|-----\|--------\|\n\| 1 \| Share the budget sheet \| Priya Nair \| Friday \| Done \|\n\| 2 \| Book the venue \| Not stated \| Not stated \| Open \|[\s\S]*## Discussion/);
  assert.equal(r.items.previous, undefined);
  // without carry nothing of this appears
  const plain = await writeMinutes({ meeting, settings, notes: '', gen: fake([], { json: J({ ...GOOD, previous: [{ id: 'a1x', status: 'done' }] }) }), ctx: ctx0 });
  assert.equal(plain.review, null);
  assert.doesNotMatch(plain.mom, /Previous Action Items/);
});

await test('carry (classic): the model is told to write the section, and its statuses are read back', async () => {
  const log = [];
  const md = `${CLASSIC_MD}\n## Previous Action Items\n| # | Action | Owner | Due | Status |\n|---|---|---|---|---|\n| 1 | Share the budget sheet | Priya | Friday | Done |\n| 2 | Book the venue | - | - | Not mentioned |\n| 9 | Ghost | - | - | Done |\n`;
  const r = await writeMinutes({ meeting, settings: { ...settings, minutesEngine: 'classic' }, notes: '', gen: fake(log, { classic: md }), ctx: { ...ctx0, carry } });
  assert.match(log[0].user, /Write a "## Previous Action Items" section/);
  assert.match(log[0].user, /\[id: a2y\] Book the venue/);
  assert.deepEqual(r.review, [{ id: 'a1x', status: 'done', note: '' }, { id: 'a2y', status: 'not mentioned', note: '' }]);
});

// ---------------- actions.js ----------------
await test('actions: seriesKey prefers the type, then the Meet code, then the title without dates; generic titles have no series', () => {
  assert.equal(X.seriesKey({ title: 'x', url: 'https://meet.google.com/abc-defg-hij' }, { id: 'cadence' }), 'type:cadence');
  assert.equal(X.seriesKey({ title: 'Anything', url: 'https://meet.google.com/abc-defg-hij?authuser=1' }), 'meet:abc-defg-hij');
  assert.equal(X.seriesKey({ title: 'Kerala UR - Cadence Call 12 Oct' }), X.seriesKey({ title: 'kerala ur cadence call (3 Nov 2026)' }));
  assert.equal(X.seriesKey({ title: 'Weekly Sync #14' }), 'title:weekly sync');
  for (const t of ['', 'Untitled meeting', 'Meeting', 'Meeting 4', undefined, 'Google Meet']) assert.equal(X.seriesKey({ title: t }), null, String(t));
});

await test('actions: previousInSeries is the newest earlier meeting of the same series within 60 days', () => {
  const day = 86400000;
  const now = at(20, 10, 0);
  const cur = { id: 'cur', title: 'Weekly Sync 20 Nov', startedAt: now };
  const metas = [
    { id: 'a', title: 'Weekly Sync 6 Nov', startedAt: now - 14 * day },
    { id: 'b', title: 'Weekly Sync 13 Nov', startedAt: now - 7 * day },
    { id: 'c', title: 'Other meeting', startedAt: now - 1 * day },
    { id: 'd', title: 'Weekly Sync 1 Sep', startedAt: now - 80 * day },
    { id: 'e', title: 'Weekly Sync next', startedAt: now + day },
    cur,
  ];
  assert.equal(X.previousInSeries(cur, metas).id, 'b');
  assert.equal(X.previousInSeries(cur, metas.filter((m) => m.id !== 'a' && m.id !== 'b')), null, 'the 80-day-old one is too old');
  assert.equal(X.previousInSeries({ id: 'z', title: 'Untitled meeting', startedAt: now }, [{ id: 'y', title: 'Untitled meeting', startedAt: now - day }]), null);
  const typeOf = (m) => (/Sync|Other/.test(m.title) ? { id: 'one' } : null);
  assert.equal(X.previousInSeries(cur, metas, typeOf).id, 'c', 'the type groups differently titled meetings');
});

await test('actions: open actions, the carry block, the review table and applyReview', () => {
  const items = { actions: [{ id: 'a', text: 'A', owner: 'X', due: 'Fri', status: 'open' }, { id: 'b', text: 'B', owner: 'Y', due: 'Not stated', status: 'done' }, { id: 'c', text: 'C | pipe', owner: 'Z', due: 'Not stated' }] };
  const open = X.openActions(items);
  assert.deepEqual(open.map((a) => a.id), ['a', 'c']);
  assert.match(X.carryText({ title: 'Sync', startedAt: at(2, 10, 0) }, open), /\(Sync, 2026-11-02\)[\s\S]*1\. \[id: a\] A \(owner: X; due: Fri\)\n2\. \[id: c\] C \| pipe/);
  const sec = X.reviewSection(open, [{ id: 'a', status: 'done' }]);
  assert.match(sec, /^## Previous Action Items\n\| # \| Action \| Owner \| Due \| Status \|\n\|---\|--------\|-------\|-----\|--------\|\n\| 1 \| A \| X \| Fri \| Done \|\n\| 2 \| C \\\| pipe \| Z \| Not stated \| Not mentioned \|$/);
  assert.equal(X.reviewSection([], []), '');
  const next = X.applyReview(items, [{ id: 'a', status: 'done' }, { id: 'c', status: 'open' }], 77);
  assert.deepEqual([next.actions[0].status, next.actions[0].doneAt, next.actions[2].status], ['done', 77, undefined]);
  assert.equal(items.actions[0].status, 'open', 'the original is untouched');
  assert.deepEqual(X.normalizeReview([{ id: 'c', status: 'not done yet' }, { id: 'nope', status: 'done' }, { id: 'c', status: 'done' }], open), [{ id: 'c', status: 'open', note: '' }]);
});

await test('actions: parseDue reads the usual date forms; unknown ones are not dates', () => {
  const ref = at(2, 10, 0); // 2 Nov 2026
  const d = (s) => X.parseDue(s, ref);
  const ymd = (x) => x && `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  assert.equal(ymd(d('2026-10-16')), '2026-10-16');
  assert.equal(ymd(d('16-Oct-26')), '2026-10-16');
  assert.equal(ymd(d('by 16 October 2026')), '2026-10-16');
  assert.equal(ymd(d('16/10/2026')), '2026-10-16');
  assert.equal(ymd(d('Oct 16, 2026')), '2026-10-16');
  assert.equal(ymd(d('12 Nov')), '2026-11-12');
  assert.equal(ymd(d('3rd Nov')), '2026-11-3');
  assert.equal(ymd(d('5 Jan')), '2027-1-5', 'a month that has already passed means next year');
  for (const s of ['Friday', 'next week', 'Not stated', '', 'ASAP', '31 Feb 2026']) assert.equal(d(s), null, s);
});

await test('actions: allOpenActions lists open actions newest meeting first with overdue; setActionStatus returns a new object', () => {
  const m1 = { id: 'm1', title: 'Old', startedAt: at(2, 10, 0), items: { actions: [{ id: 'a', text: 'A', owner: 'X', due: '10-Nov-26', at: '00:10', status: 'open' }, { id: 'b', text: 'B', owner: 'X', due: '01-Nov-26', status: 'done' }] } };
  const m2 = { id: 'm2', title: 'New', startedAt: at(9, 10, 0), items: { actions: [{ id: 'c', text: 'C', owner: 'Y', due: 'Friday', at: '', status: 'open' }, { id: 'd', text: 'D', owner: 'Y', due: '17-Nov-26' }] } };
  const list = X.allOpenActions([m1, m2, { id: 'm3', title: 'No items', startedAt: 1 }], { today: new Date(2026, 10, 16, 15, 0) });
  assert.deepEqual(list.map((x) => [x.meetingId, x.id, x.overdue]), [['m2', 'c', false], ['m2', 'd', false], ['m1', 'a', true]]);
  assert.deepEqual(Object.keys(list[2]).sort(), ['at', 'date', 'due', 'id', 'meetingId', 'overdue', 'owner', 'status', 'text', 'title']);
  const items = m1.items;
  const done = X.setActionStatus(items, 'a', 'done', 5);
  assert.notEqual(done, items);
  assert.deepEqual([done.actions[0].status, done.actions[0].doneAt, items.actions[0].status], ['done', 5, 'open']);
  const reopened = X.setActionStatus(done, 'a', 'open');
  assert.equal(reopened.actions[0].status, 'open');
  assert.ok(!('doneAt' in reopened.actions[0]));
  assert.deepEqual(X.setActionStatus(items, 'nope', 'done').actions.map((a) => a.status), ['open', 'done']);
});

// ---------------- llm: the json option ----------------
let fetchCalls = [];
let responder = null;
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
  return responder(fetchCalls.length);
};
const sse = (events) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.join(''))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const oaOk = () => sse(['data: {"choices":[{"delta":{"content":"{\\"a\\":1}"}}]}\n\n', 'data: [DONE]\n\n']);
const gemOk = () => sse(['data: {"candidates":[{"content":{"parts":[{"text":"{\\"a\\":1}"}]}}]}\r\n\r\n']);

await test('llm json (OpenAI-compatible): response_format is sent, one step down on 400/422, nothing changes without json', async () => {
  const s = { ...DEFAULTS, llmProvider: 'openai', oaKey: 'k', oaModel: 'm1', oaBase: 'http://localhost:1234/v1' };
  fetchCalls = [];
  responder = oaOk;
  const parts = [];
  assert.equal(await generate({ settings: s, system: 'S', user: 'U', onText: (d) => parts.push(d), json: true, temperature: 0.2 }), '{"a":1}');
  assert.deepEqual(fetchCalls[0].body.response_format, { type: 'json_object' });
  assert.equal(parts.join(''), '{"a":1}');
  for (const status of [400, 422]) {
    fetchCalls = [];
    responder = (n) => (n === 1 ? new Response('{"error":{"message":"response_format unsupported"}}', { status }) : oaOk());
    assert.equal(await generate({ settings: s, system: 'S', user: 'U', onText: () => {}, json: true }), '{"a":1}');
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].body.response_format && !fetchCalls[1].body.response_format);
  }
  fetchCalls = [];
  responder = () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
  await assert.rejects(() => generate({ settings: s, system: 'S', user: 'U', onText: () => {}, json: true }), /HTTP 401/);
  assert.equal(fetchCalls.length, 1, 'only a 400/422 is retried');
  fetchCalls = [];
  responder = oaOk;
  await generate({ settings: s, system: 'S', user: 'U', onText: () => {} });
  assert.ok(!('response_format' in fetchCalls[0].body));
});

await test('llm json (Gemini): responseMimeType is sent next to the temperature, a 400 is retried once without it, nothing changes without json', async () => {
  const s = { ...DEFAULTS, llmProvider: 'gemini', geminiKey: 'g', geminiModel: 'gem-x' };
  fetchCalls = [];
  responder = gemOk;
  assert.equal(await generate({ settings: s, system: 'S', user: 'U', onText: () => {}, json: true, temperature: 0.2 }), '{"a":1}');
  assert.deepEqual(fetchCalls[0].body.generationConfig, { temperature: 0.2, responseMimeType: 'application/json' });
  fetchCalls = [];
  responder = (n) => (/responseMimeType/.test(JSON.stringify(fetchCalls[n - 1].body)) ? new Response('{"error":{"message":"Invalid JSON payload: responseMimeType"}}', { status: 400 }) : gemOk());
  assert.equal(await generate({ settings: s, system: 'S', user: 'U', onText: () => {}, json: true }), '{"a":1}');
  assert.ok(!/responseMimeType/.test(JSON.stringify(fetchCalls[fetchCalls.length - 1].body)));
  fetchCalls = [];
  responder = gemOk;
  await generate({ settings: s, system: 'S', user: 'U', onText: () => {}, temperature: 0 });
  assert.deepEqual(fetchCalls[0].body.generationConfig, { temperature: 0 });
  fetchCalls = [];
  await generate({ settings: s, system: 'S', user: 'U', onText: () => {} });
  assert.ok(!('generationConfig' in fetchCalls[0].body));
});

await test('llm json (Claude): no parameter changes', async () => {
  const s = { ...DEFAULTS, llmProvider: 'anthropic', anthropicKey: 'sk-ant-test', anthropicModel: 'claude-sonnet-4-5' };
  const run = async (json) => {
    fetchCalls = [];
    responder = () => sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n']);
    await generate({ settings: s, system: 'S', user: 'U', onText: () => {}, json, temperature: 0.2 });
    return fetchCalls[0].body;
  };
  assert.deepEqual(await run(true), await run(undefined));
});

await test('prompt: the structured system prompt reuses the shared rules and shows a valid example', () => {
  const sys = S.structuredSystem('Hindi', { languages: 'Hindi, English' });
  for (const t of [P.TRANSCRIPT_NOTES, P.INJECTION_GUARD, P.NAMES_RULES, 'Capture EVERY decision', 'Write every string in Hindi', 'ONE JSON document', 'Never output a web address']) assert.ok(sys.includes(t), t.slice(0, 40));
  const example = sys.slice(sys.indexOf('Example of a valid reply:\n') + 26).split('\n')[0];
  const p = S.parseStructured(example);
  assert.ok(p && p.actions.length === 1 && p.decisions.length === 1);
  const user = S.structuredUser(meeting, DEFAULTS, 'note text', { checklist: 'ACTION x', attendees: ['Amal Raj'] });
  assert.match(user, /<transcript>[\s\S]*<\/transcript>[\s\S]*<checklist>\nACTION x/);
});

console.log(`\n${passed} passed`);
