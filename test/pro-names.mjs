// Pro features: dictionary, name correction, multi-pass minutes, attendance.
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/store.js';

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

const D = await import('../src/dictionary.js');

// ---------------- dictionary ----------------
await test('dictionary: parses entries, aliases and comments', () => {
  const e = D.parseDictionary('# team\nAmal | Aman, Amaal\nUnified Registry\n\nDSM | Dee Es Em , DSM');
  assert.deepEqual(e, [
    { name: 'Amal', aliases: ['Aman', 'Amaal'] },
    { name: 'Unified Registry', aliases: [] },
    { name: 'DSM', aliases: ['Dee Es Em'] },
  ]);
  assert.equal(D.serializeDictionary(e), 'Amal | Aman, Amaal\nUnified Registry\nDSM | Dee Es Em');
});

await test('dictionary: replaces misheard names as whole words only, in any script', () => {
  const e = D.parseDictionary('Amal | Aman\nसचिन | सचीन');
  assert.equal(D.applyDictionary('Aman said Amanda will join; aman agreed.', e), 'Amal said Amanda will join; Amal agreed.');
  assert.equal(D.applyDictionary('हाँ सचीन भाई', e), 'हाँ सचिन भाई');
  assert.equal(D.applyDictionary('nothing here', e), 'nothing here');
  assert.equal(D.applyDictionary('Aman', [], []), 'Aman');
});

await test('dictionary: an alias that is really in the meeting is left alone', () => {
  const e = D.parseDictionary('Amal | Aman');
  assert.equal(D.applyDictionary('Aman will send it', e, ['Amal Raj']), 'Amal will send it');
  assert.equal(D.applyDictionary('Aman will send it', e, ['Aman Verma', 'Amal Raj']), 'Aman will send it', 'both are here, so do not guess');
  assert.equal(D.applyDictionary('Aman will send it', e, []), 'Amal will send it');
});

await test('dictionary: learns an alias and does not duplicate', () => {
  let t = D.learnAlias('', 'Amal', 'Aman');
  assert.equal(t, 'Amal | Aman');
  t = D.learnAlias(t, 'amal', 'Amaal');
  t = D.learnAlias(t, 'Amal', 'Aman');
  assert.equal(t, 'Amal | Aman, Amaal');
  assert.equal(D.replaceWord('Aman and Amanda', 'Aman', 'Amal'), 'Amal and Amanda');
});

await test('dictionary: suggests one-letter-off attendee names, never common words', () => {
  const text = 'Then Amam will check. The Team agreed. Priyaa said yes. Amam again.';
  const s = D.suggestNames(text, ['Amal Raj', 'Priya Nair'], []);
  assert.deepEqual(s.map((x) => [x.found, x.suggest, x.count]), [['Amam', 'Amal', 2], ['Priyaa', 'Priya', 1]]);
  assert.deepEqual(D.suggestNames('Amam', [], []), []);
});

// ---------------- prompts ----------------
const P = await import('../src/prompt.js');
const meeting = { title: 'UR sync', startedAt: Date.UTC(2026, 9, 13, 5, 0), endedAt: Date.UTC(2026, 9, 13, 5, 30), segments: [{ t: 12, src: 'others', text: 'Aman will share the file by Friday.' }, { t: 3, src: 'me', text: 'ok' }] };

await test('prompt: fixes names in the transcript and lists names, attendees and absentees', () => {
  const entries = D.parseDictionary('Amal | Aman');
  const u = P.buildUserPrompt(meeting, { ...DEFAULTS, myName: 'Shrawin' }, '', { entries, attendees: ['Amal Raj'], absent: ['Priya'], checklist: 'ACTION [00:12] share file' });
  assert.match(u, /Amal will share the file/);
  assert.doesNotMatch(u, /Aman will/);
  assert.match(u, /Names and terms \(spell exactly like this\): Amal Raj, Amal/);
  assert.match(u, /Attendees in the meeting: Amal Raj/);
  assert.match(u, /NOT seen in the meeting: Priya/);
  assert.match(u, /<checklist>\nACTION \[00:12\] share file\n<\/checklist>/);
});

await test('prompt: action items carry a source, speaker timeline is optional', () => {
  assert.match(P.buildSystemPrompt('English'), /\| # \| Action \| Owner \| Due \| Source \|/);
  assert.doesNotMatch(P.buildSystemPrompt('English', { evidence: false }), /Source/);
  const caps = [{ t: 5, name: 'Amal', text: 'hello' }, { t: 9, name: 'Amal', text: 'there' }, { t: 60, name: 'Priya', text: 'hi' }];
  const tl = P.speakerTimeline(caps);
  assert.equal(tl.split('\n').length, 2);
  assert.match(tl, /Amal: hello there/);
  assert.equal(P.speakerTimeline([]), '');
});

await test('prompt: windows, item parsing and checklist de-duplication', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `[00:0${i}] OTHERS: ${'word '.repeat(10)}`);
  const w = P.splitWindows(lines, 35);
  assert.ok(w.length >= 3);
  assert.equal(w[1][0], w[0][w[0].length - 1], 'one line of overlap');
  const items = P.parseItems('1. ACTION | Amal | Friday | [12:40] | share the file | "kal tak bhej dunga"\nDECISION | - | - | [13:00] | go ahead\nrandom chatter\nNONE\nACTION | Amal | Friday | [12:41] | Share the file | quote');
  assert.equal(items.length, 3);
  assert.equal(items[0].owner, 'Amal');
  const list = P.itemsToChecklist(items).split('\n');
  assert.equal(list.length, 2, 'duplicates merged');
  assert.match(list[0], /^ACTION \[12:40\] share the file \(owner: Amal\) \(due: Friday\)/);
});

// ---------------- minutes pipeline ----------------
const { writeMinutes, coverageMarkdown } = await import('../src/minutes.js');
const long = { ...meeting, segments: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, src: 'others', text: `item ${i} `.repeat(60) })) };

await test('minutes: thorough mode extracts per window, writes with the checklist, then audits', async () => {
  const calls = [];
  const gen = async (system, user, onText) => {
    calls.push({ system, user });
    if (/extract facts/.test(system)) return 'ACTION | Amal | Friday | [01:00] | send file | "send file"';
    if (/audit meeting minutes/.test(system)) return '[05:00] a forgotten decision | "we decided"';
    onText?.('# Title\n');
    return '# Title\n\n## Action Items\n| 1 | send file |';
  };
  const r = await writeMinutes({ meeting: long, settings: { ...DEFAULTS, momLanguage: 'English' }, notes: '', gen, ctx: {} });
  assert.ok(r.stats.extractWindows >= 2, JSON.stringify(r.stats));
  assert.ok(calls.some((c) => /<checklist>/.test(c.user) && /send file/.test(c.user)), 'final write sees the checklist');
  assert.match(r.mom, /## Added by the completeness check/);
  assert.match(r.mom, /a forgotten decision/);
  assert.match(r.mom, /model calls/);
  assert.equal(r.stats.missed, 1);
});

await test('minutes: writing again reuses the items found the first time, so the count cannot jump; re-read forces a fresh read', async () => {
  let extractCalls = 0;
  let temps = [];
  let answer = 'ACTION | Amal | Friday | [01:00] | send file | "send file"';
  const gen = async (system, user, onText, opts) => {
    temps.push([/extract facts/.test(system) ? 'extract' : /audit meeting minutes/.test(system) ? 'check' : 'write', opts?.temperature]);
    if (/extract facts/.test(system)) {
      extractCalls++;
      return answer;
    }
    if (/audit meeting minutes/.test(system)) return 'NONE';
    return '# Title';
  };
  const settings = { ...DEFAULTS, momLanguage: 'English' };
  const first = await writeMinutes({ meeting: long, settings, notes: '', gen, ctx: {} });
  const firstCalls = extractCalls;
  assert.ok(firstCalls >= 2 && first.extract?.items.length >= 2, 'a first read extracts and returns the items to keep');
  assert.ok(temps.some(([k, t]) => k === 'extract' && t === 0), 'extraction asks for repeatable output');
  assert.ok(temps.some(([k, t]) => k === 'check' && t === 0));
  assert.ok(temps.some(([k, t]) => k === 'write' && t > 0 && t <= 0.3));
  // the model would now answer differently (more items), but a rewrite must not re-extract
  answer = ['ACTION | A | - | [01:00] | one | "x"', 'ACTION | B | - | [02:00] | two | "y"', 'ACTION | C | - | [03:00] | three | "z"'].join('\n');
  const again = await writeMinutes({ meeting: { ...long, extract: first.extract }, settings, notes: '', gen, ctx: {} });
  assert.equal(extractCalls, firstCalls, 'no new extraction calls');
  assert.equal(again.stats.reused, true);
  assert.equal(again.stats.items, first.stats.items, 'the same number of items');
  const fresh = await writeMinutes({ meeting: { ...long, extract: first.extract }, settings, notes: '', gen, ctx: { reread: true } });
  assert.ok(extractCalls > firstCalls);
  assert.ok(fresh.stats.items > first.stats.items);
  // a changed transcript is never served from the old read
  const edited = { ...long, segments: [...long.segments, { t: 9999, src: 'others', text: 'a brand new sentence '.repeat(40) }], extract: first.extract };
  const n0 = extractCalls;
  await writeMinutes({ meeting: edited, settings, notes: '', gen, ctx: {} });
  assert.ok(extractCalls > n0);
  // a read with a failed part is not kept (it would lock in the gap)
  let k = 0;
  const flaky = await writeMinutes({ meeting: long, settings, notes: '', gen: async (s, u, o, p) => { if (/extract facts/.test(s) && k++ === 0) throw new Error('boom'); return gen(s, u, o, p); }, ctx: {} });
  assert.equal(flaky.extract, null);
});

await test('minutes: quick mode and short meetings use a single pass', async () => {
  let n = 0;
  const gen = async () => (n++, '# Title');
  const r1 = await writeMinutes({ meeting, settings: { ...DEFAULTS, minutesFormat: 'standard' }, gen, ctx: {} });
  assert.equal(n, 1);
  assert.match(r1.mom, /a single pass/);
  n = 0;
  await writeMinutes({ meeting: long, settings: { ...DEFAULTS, minutesMode: 'quick', minutesFormat: 'standard' }, gen, ctx: {} });
  assert.equal(n, 1);
});

await test('minutes: a failed extraction part does not fail the minutes', async () => {
  let k = 0;
  const gen = async (system) => {
    if (/extract facts/.test(system) && k++ === 0) throw new Error('boom');
    return /extract facts/.test(system) ? 'NONE' : /audit/.test(system) ? 'NONE' : '# T';
  };
  const r = await writeMinutes({ meeting: long, settings: { ...DEFAULTS }, gen, ctx: {} });
  assert.equal(r.stats.extractFailed, 1);
  assert.match(r.mom, /extraction part\(s\) failed/);
});

await test('minutes: coverage warning when audio could not be transcribed', () => {
  assert.match(coverageMarkdown({ pendingCount: 2, pendingSec: 300 }), /5 min of audio \(2 pieces\)/);
  assert.equal(coverageMarkdown({}), '');
});

// ---------------- attendance ----------------
const A = await import('../src/attendance.js');
const invited = [
  { name: 'Amal Raj', email: 'amal.raj@co.com', status: 'yes' },
  { name: 'Priya Nair', email: 'priya@co.com', status: 'yes' },
  { name: 'Ravi Kumar', email: 'ravi.kumar@co.com', status: 'maybe' },
  { name: 'Shrawin Sisodiya', email: 'shrawin@co.com', status: 'owner' },
];
const presence = { 'Amal R.': [10, 1500, 90], You: [0, 1800, 100], 'Priya Nair': [400, 1800, 80], 'Guest Visitor': [900, 1000, 10] };

await test('attendance: matches calendar names to display names, finds absent and uninvited', () => {
  const m = A.matchPeople(invited, presence, { entries: [], myName: 'Shrawin Sisodiya' });
  const by = Object.fromEntries(m.rows.map((r) => [r.name, !!r.present]));
  assert.deepEqual(by, { 'Amal Raj': true, 'Priya Nair': true, 'Ravi Kumar': false, 'Shrawin Sisodiya': true });
  assert.deepEqual(m.uninvited.map((p) => p.name), ['Guest Visitor']);
});

await test('attendance: dictionary aliases link a misspelt display name', () => {
  const entries = D.parseDictionary('Amal Raj | Aman Raj');
  const m = A.matchPeople([{ name: 'Amal Raj', email: 'x@y.com' }], { 'Aman Raj': [0, 10, 1] }, { entries });
  assert.ok(m.rows[0].present);
});

await test('attendance: table lists absent people, late joiners and early leavers', () => {
  const md = A.attendanceMarkdown({ invited, presence, durationSec: 1800, entries: [], myName: 'Shrawin Sisodiya' });
  assert.match(md, /3 of 4 invited people were seen/);
  assert.match(md, /\| Ravi Kumar \| Maybe \| \*\*Absent\*\*/);
  assert.match(md, /\| Priya Nair \| Accepted \| Yes \| 06:40 \| 30:00 \| joined late \|/);
  assert.match(md, /\| Amal Raj \| Accepted \| Yes \| 00:10 | 25:00 | left early\| 28:20 \| left early \|/);
  assert.match(md, /Guest Visitor \| Not invited/);
  assert.match(md, /Not seen in the meeting: Ravi Kumar/);
  assert.equal(A.attendanceMarkdown({ invited: [], presence: {} }), '');
  assert.match(A.attendanceMarkdown({ invited: [], presence: { You: [0, 5, 1] }, durationSec: 5, myName: 'Me' }), /\| Me \|/);
});


// ---------------- guards ----------------
const G = await import('../src/prompt.js');
await test('guard: an owner the transcript does not back is dropped, a backed one is kept', () => {
  const text = '[00:10] OTHERS: Amal will share the validation sheet by Friday. Priya raised a risk about the mapping file. Please send the revised timeline to the client by Monday evening.';
  const items = [
    { type: 'ACTION', owner: 'Amal Raj', due: 'Friday', at: '[00:10]', text: 'share sheet', quote: 'Amal will share the validation sheet' },
    { type: 'ACTION', owner: 'Priya Nair', due: '-', at: '[00:10]', text: 'send timeline', quote: 'send the revised timeline to the client' },
    { type: 'ACTION', owner: 'Ravi', due: '-', at: '[00:10]', text: 'x', quote: 'nowhere to be found in the text at all' },
  ];
  const out = G.guardOwners(items, text);
  assert.equal(out[0].owner, 'Amal Raj');
  assert.equal(out[1].owner, '-');
  assert.equal(out[1].ownerDropped, 'Priya Nair');
  assert.equal(out[2].owner, 'Ravi', 'unverifiable items are left alone');
});

await test('guard: leaked prompt tags, fences and placeholders are stripped from the minutes', () => {
  const dirty = '```markdown\n# T\n<checklist>\nFoo | quote_of_max_12_words\n</checklist>\n- point "quote_of_max_12_words"\n```';
  const clean = G.sanitizeMinutes(dirty);
  assert.doesNotMatch(clean, /checklist|quote_of|```/);
  assert.match(clean, /# T/);
  assert.match(clean, /- point/);
});


// ---------------- auto-learning ----------------
await test('learning: real names from the meeting are learned, mishearings are queued, "You" is ignored', () => {
  const m = {
    attendees: ['Amal Raj'],
    presence: { You: [0, 10, 1], 'Priya N.': [0, 10, 1], 'Guest': [0, 1, 1] },
    invited: [{ name: 'Ravi Kumar', email: 'ravi@x.com', status: 'yes' }, { name: '', email: 'sita.menon@x.com', status: 'maybe' }, { name: 'Declined Dan', email: 'd@x.com', status: 'no' }],
    captions: [{ name: 'Amal Raj', text: 'hi' }],
    segments: [{ t: 1, src: 'others', text: 'Then Amam will check it. Amam again said yes. Ok Priya.' }],
  };
  const r = D.learnFromMeeting(m, { entries: [], myName: 'Shrawin' });
  assert.deepEqual(r.names.sort(), ['Amal Raj', 'Priya N.', 'Ravi Kumar', 'Shrawin', 'Sita Menon'].sort());
  assert.deepEqual(r.candidates.map((c) => [c.found, c.suggest, c.count]), [['Amam', 'Amal', 2]]);
});

await test('learning: merging remembers names, counts repeated fixes, honours dismissals, auto-accepts at 3', () => {
  const found = { names: ['Amal Raj'], candidates: [{ found: 'Amam', suggest: 'Amal', count: 2 }] };
  let { learned, accepted } = D.mergeLearned(null, found, { title: 'Sync', now: 1000 });
  assert.equal(learned.pending.length, 1);
  assert.equal(accepted.length, 0);
  ({ learned, accepted } = D.mergeLearned(learned, found, { title: 'Sync 2', now: 2000 }));
  assert.equal(learned.pending[0].count, 4);
  ({ learned, accepted } = D.mergeLearned(learned, { names: [], candidates: [] }, { auto: true }));
  assert.deepEqual(accepted.map((a) => a.found), ['Amam']);
  assert.equal(learned.pending.length, 0);
  const rejected = { names: {}, pending: [], rejected: ['amam>amal'] };
  assert.equal(D.mergeLearned(rejected, found).learned.pending.length, 0, 'a dismissed fix stays dismissed');
  const big = { names: Object.fromEntries(Array.from({ length: 305 }, (_, i) => [`N${i}`, i])), pending: [], rejected: [] };
  assert.equal(Object.keys(D.mergeLearned(big, { names: ['New'], candidates: [] }).learned.names).length, 300);
});

await test('learning: learned names reach the speech hints and the prompt, never the settings file', async () => {
  const { DEFAULTS: DF } = await import('../src/store.js');
  const { buildUserPrompt: bup } = await import('../src/prompt.js');
  const u = bup({ title: 't', startedAt: 0, segments: [] }, { ...DF }, '', { entries: [], attendees: [], learned: ['Sita Menon'] });
  assert.match(u, /Names and terms \(spell exactly like this\): Sita Menon/);
  const stored = {};
  globalThis.chrome = { storage: { local: { get: async () => ({ settings: { myName: 'X' }, learned: { names: { 'Amal Raj': 5, 'Priya Nair': 9 } } }), set: async (o) => Object.assign(stored, o) } } };
  const { getSettings, saveSettings } = await import('../src/store.js');
  const s = await getSettings();
  assert.deepEqual(s.learnedNames, ['Amal Raj', 'Priya Nair']);
  await saveSettings(s);
  assert.equal('learnedNames' in stored.settings, false);
  delete globalThis.chrome;
});

console.log(`\n${passed} passed`);
