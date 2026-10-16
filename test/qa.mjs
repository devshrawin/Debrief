// Regression tests for defects found in the full QA pass. Each test is a case that failed before the fix.
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
const A = await import('../src/attendance.js');
const P = await import('../src/prompt.js');
const M = await import('../src/mailer.js');
const { writeMinutes } = await import('../src/minutes.js');

// ---- dictionary ----
await test('dictionary: Devanagari and Malayalam words are not cut at vowel signs', () => {
  assert.equal(D.applyDictionary('रामू और किराम', D.parseDictionary('Ram | राम')), 'रामू और किराम');
  assert.equal(D.applyDictionary('राम आया', D.parseDictionary('Ram | राम')), 'Ram आया');
  assert.equal(D.applyDictionary('ദീപു വന്നു', D.parseDictionary('Deepa | ദീപ')), 'ദീപു വന്നു');
  assert.equal(D.replaceWord('रामू राम', 'राम', 'Ram'), 'रामू Ram');
});

await test('dictionary: replacement text is literal, never a $ pattern', () => {
  assert.equal(D.replaceWord('hi Amal', 'Amal', '$&$&'), 'hi $&$&');
  assert.equal(D.applyDictionary('amaal here', D.parseDictionary('R$&D | amaal')), 'R$&D here');
});

await test('dictionary: one correction is never corrected again by another entry', () => {
  const e = D.parseDictionary('Amal | Aman\nAmar | Amal');
  assert.equal(D.applyDictionary('Aman and Amal', e), 'Amal and Amar');
});

await test('dictionary: learnAlias keeps comments and refuses separators in names', () => {
  assert.equal(D.learnAlias('# my team\nAmal | Aman', 'Priya', 'Priyaa'), '# my team\nAmal | Aman\nPriya | Priyaa');
  assert.equal(D.learnAlias('Amal | Aman', 'Amal', 'a, b | c'), 'Amal | Aman, a b c');
  assert.equal(D.learnAlias('', 'A | B', 'x\ny'), 'A B | x y');
  assert.equal(D.learnAlias('Amal | Aman', 'amal', 'AMAN'), 'Amal | Aman');
});

await test('dictionary: a big dictionary over a long meeting stays fast', () => {
  const entries = D.parseDictionary(Array.from({ length: 500 }, (_, i) => `Name${i} | Nam${i}a, Nme${i}, Nam${i}e`).join('\n'));
  const text = 'we asked Nam7a and Nme9 about Nam499e today but also general words '.repeat(12);
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) D.applyDictionary(text, entries, ['Priya']);
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.match(D.applyDictionary(text, entries), /Name7 and Name9 about Name499/);
});

// ---- attendance ----
await test('attendance: different people with similar names are not merged', () => {
  const m1 = A.matchPeople([{ name: 'Aman Sharma' }], { 'Amal Verma': [0, 10, 1] }, {});
  assert.equal(m1.rows[0].present, null);
  assert.equal(m1.uninvited.length, 1);
  const m2 = A.matchPeople([{ name: 'Amal Rao' }], { 'Amal Raj': [0, 10, 1] }, {});
  assert.equal(m2.rows[0].present, null);
  const m3 = A.matchPeople([{ name: 'Amal Raj' }], { 'Amal R.': [0, 10, 1] }, {});
  assert.ok(m3.rows[0].present, 'an initial still matches');
});

await test('attendance: a bare first name is ignored when two invitees share it', () => {
  const m = A.matchPeople([{ name: 'Amal Raj' }, { name: 'Amal Rao' }], { Amal: [0, 10, 1] }, {});
  assert.equal(m.rows.filter((r) => r.present).length, 0);
  const one = A.matchPeople([{ name: 'Amal Raj' }, { name: 'Priya Nair' }], { Amal: [0, 10, 1] }, {});
  assert.ok(one.rows[0].present);
});

await test('attendance: "You" maps to the organiser when no name is set', () => {
  const m = A.matchPeople([{ name: 'Me Self', status: 'owner' }, { name: 'Priya' }], { You: [0, 100, 5] }, {});
  assert.ok(m.rows[0].present);
  assert.equal(m.uninvited.length, 0);
});

// ---- minutes pipeline ----
await test('minutes: an empty model reply is an error, not blank minutes', async () => {
  const meeting = { title: 't', startedAt: 0, endedAt: 60000, segments: [{ t: 1, src: 'others', text: 'hello there' }] };
  await assert.rejects(() => writeMinutes({ meeting, settings: { ...DEFAULTS }, gen: async () => '   ', ctx: {} }), /empty reply/);
});

await test('minutes: completeness chatter is dropped, real findings kept', async () => {
  const meeting = { title: 't', startedAt: 0, endedAt: 60000, segments: Array.from({ length: 30 }, (_, i) => ({ t: i * 60, src: 'others', text: `topic ${i} `.repeat(60) })) };
  const gen = async (system) => (/audit/.test(system) ? 'Nothing is missing.\n[05:00] a forgotten decision | "we decided"' : /extract facts/.test(system) ? 'NONE' : '# T');
  const r = await writeMinutes({ meeting, settings: { ...DEFAULTS }, gen, ctx: {} });
  assert.match(r.mom, /a forgotten decision/);
  assert.doesNotMatch(r.mom, /Nothing is missing/);
});

await test('prompt: owner guard works in Devanagari and keeps cross-script owners', () => {
  const text = 'सुरेश यह रिपोर्ट कल तक भेज देगी। मीटिंग खत्म।';
  const items = [{ type: 'ACTION', owner: 'प्रिया', due: '-', at: '[00:10]', text: 'x', quote: 'यह रिपोर्ट कल तक भेज देगी' }];
  assert.equal(P.guardOwners(items, text)[0].owner, '-', 'an owner the sentence does not name is dropped');
  const ok = [{ type: 'ACTION', owner: 'सुरेश', due: '-', at: '[00:10]', text: 'x', quote: 'यह रिपोर्ट कल तक भेज देगी' }];
  assert.equal(P.guardOwners(ok, text)[0].owner, 'सुरेश');
  const latin = [{ type: 'ACTION', owner: 'Amal', due: '-', at: '[00:10]', text: 'x', quote: 'यह रिपोर्ट कल तक भेज देगी' }];
  assert.equal(P.guardOwners(latin, text)[0].owner, 'Amal', 'cannot compare scripts, so keep the owner');
});

await test('prompt: sanitize only unwraps a fully wrapped reply and keeps real code blocks', () => {
  assert.equal(P.sanitizeMinutes('```markdown\n# T\n- a\n```'), '# T\n- a');
  const withCode = '# T\n```sql\nselect 1;\n```';
  assert.equal(P.sanitizeMinutes(withCode), withCode);
  assert.equal(P.sanitizeMinutes('- Review the <checklist> section'), '- Review the <checklist> section');
  assert.equal(P.sanitizeMinutes('# T\n<checklist>\nx\n</checklist>'), '# T\nx');
});

await test('prompt: windows never repeat a window made only of the overlap line', () => {
  const lines = Array.from({ length: 4 }, (_, i) => `[0${i}:00] OTHERS: ${'word '.repeat(800)}`);
  const w = P.splitWindows(lines, 1500);
  assert.ok(w.every((x) => x.length > 1 || w.length === 1), JSON.stringify(w.map((x) => x.length)));
  assert.equal(w.flat().filter((l, i, a) => a.indexOf(l) === i).length, 4, 'every line is covered');
  assert.deepEqual(P.splitWindows([], 100), []);
});

await test('prompt: item parsing tolerates bold, colons and a pipe in the description', () => {
  const items = P.parseItems('**ACTION** | Amal | Fri | [01:00] | send the file | "quote"\nDECISION: - | - | [02:00] | go ahead | "ok"\nACTION | | | |\nACTION | Ravi | - | [03:00] | fix a | b | "quote here"');
  assert.equal(items.length, 3);
  assert.equal(items[0].text, 'send the file');
  assert.equal(items[1].type, 'DECISION');
  assert.equal(items[2].text, 'fix a b');
  assert.equal(items[2].quote, '"quote here"');
});

// ---- email builder ----
await test('mailer: table cells get exactly one style and an existing style is kept', () => {
  const html = M.buildEmail({ title: 't', startedAt: 0, mom: 'x' }, { ...DEFAULTS, emailPdf: false }, () => '<table><tr><th>A</th><td style="text-align:right">1</td><td>2</td></tr></table>', '').html;
  assert.equal((html.match(/<td [^>]*style=/g) || []).length, 2);
  assert.doesNotMatch(html, /style="[^"]*" style=/);
  assert.match(html, /<td style="text-align:right">1<\/td>/);
});

await test('mailer: addresses with quotes are rejected so the generated script stays valid', () => {
  assert.deepEqual(M.parseAddresses("o'brien@x.com, a']+Evil()+['b@c.co, good@x.com"), ['good@x.com']);
  const out = M.scriptWithAllowList("const ALLOWED = [];\nconst ALLOWED_DOMAINS = [];", ['good@x.com'], {});
  assert.match(out, /const ALLOWED = \['good@x\.com'\];/);
});


// ---- languages: any number, in any order ----
const L = await import('../src/languages.js');
const S = await import('../src/stt.js');

await test('languages: the chosen list drives Gemini codes, hints and legacy settings still work', () => {
  assert.equal(L.chosenLanguages({ meetingLanguages: [], meetingLanguage: 'auto' }), null);
  assert.deepEqual(L.chosenLanguages({ meetingLanguage: 'malayalam' }).map((l) => l.code), ['ml', 'en']);
  assert.deepEqual(L.chosenLanguages({ meetingLanguages: ['ta', 'te', 'en', 'xx'] }).map((l) => l.code), ['ta', 'te', 'en'], 'unknown codes are ignored');
  assert.deepEqual(L.geminiCodes(L.chosenLanguages({ meetingLanguages: ['ta', 'en'] })), ['ta-IN', 'en-IN']);
  assert.equal(L.geminiCodes(null), null);
  const hint = L.languageHint(L.chosenLanguages({ meetingLanguages: ['ta', 'te', 'en'] }));
  assert.match(hint, /Tamil, Telugu and English/);
  assert.match(hint, /Tamil in Tamil script, Telugu in Telugu script and English words in English/);
  assert.equal(L.languagesOf({}).length, 3, 'automatic describes Hindi, English and Malayalam');
  assert.equal(L.minutesLanguageOptions().at(-1).label, 'Same as the meeting');
  assert.ok(L.LANGUAGES.length >= 18);
});

await test('languages: providers that take one language are narrowed only when exactly one is chosen', async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), req: new Request(url, init) });
    return Response.json({ transcript: 'x', text: 'y' });
  };
  const wav = (await import('../src/wav.js')).encodeWav(new Float32Array(16000), 16000);
  const run = async (settings) => {
    seen.length = 0;
    await S.transcribe(wav, settings);
    return seen[0].req.formData();
  };
  assert.equal((await run({ ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'k', meetingLanguages: ['ta'] })).get('language_code'), 'ta-IN');
  assert.equal((await run({ ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'k', meetingLanguages: ['ta', 'en'] })).get('language_code'), 'ta-IN', 'English does not count as a second language');
  assert.equal((await run({ ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'k', meetingLanguages: ['ta', 'te'] })).get('language_code'), 'unknown');
  assert.equal((await run({ ...DEFAULTS, sttProvider: 'sarvam', sarvamKey: 'k', meetingLanguages: ['fr'] })).get('language_code'), 'unknown', 'Sarvam only knows Indian languages');
  const w = await run({ ...DEFAULTS, sttProvider: 'openai', sttBase: 'http://x/v1', meetingLanguages: ['te', 'en'] });
  assert.equal(w.get('language'), 'te');
  assert.match(w.get('prompt'), /Telugu and English office meeting/);
  assert.equal((await run({ ...DEFAULTS, sttProvider: 'openai', sttBase: 'http://x/v1', meetingLanguages: ['hi', 'ml'] })).get('language'), null);
});

await test('languages: the minutes prompt names the chosen languages', () => {
  assert.match(P.buildSystemPrompt('English', { languages: 'Tamil and English' }), /held in Tamil and English, or a mix of them/);
  assert.match(P.buildSystemPrompt('English'), /Hindi, English, Malayalam/);
});

await test('attendance: the table lists invitees present and absent; with no invite it says why instead of guessing', async () => {
  const { attendanceMarkdown } = await import('../src/attendance.js');
  const { noInviteReason } = await import('../src/minutes.js');
  const invited = [{ name: 'Akash Behera', email: 'akash@co.com', status: 'yes' }, { name: 'Ankur Desai', email: 'ankur@co.com', status: 'yes' }, { name: 'Deep Patel', email: 'deep@co.com', status: 'invited' }];
  const presence = { 'Akash Behera': [10, 400, 5], 'Ankur Desai': [200, 410, 5], Visitor: [50, 300, 3] };
  const md = attendanceMarkdown({ invited, presence, durationSec: 420, entries: [], myName: '' });
  assert.match(md, /\| Person \| Invite \| In the meeting \|/);
  assert.match(md, /\| Akash Behera \(akash@co.com\) \| Accepted \| Yes \|/);
  assert.match(md, /\| Deep Patel \(deep@co.com\) \| No reply \| \*\*Absent\*\* \|/);
  assert.match(md, /\| Visitor \| Not invited \| Yes \|/);
  assert.match(md, /2 of 3 invited people/);
  assert.match(md, /Absent. means not seen/);
  const none = attendanceMarkdown({ invited: [], presence, durationSec: 420, entries: [], myName: '', whyNoInvite: noInviteReason({ invitedNotFound: true }, { calendarLookup: true }) });
  assert.match(none, /Nobody can be listed as absent because no calendar event with this meeting/);
  assert.match(noInviteReason({ invitedError: 'locked' }, {}), /lookup failed \(locked\)/);
  assert.match(noInviteReason({}, { calendarLookup: false }), /switched off/);
  assert.match(noInviteReason({}, { calendarLookup: true }), /has not run/);
});

await test('attendance: invitees given only as e-mail addresses are matched to the names seen, and "More options for X" is X', async () => {
  const { matchPeople, attendanceMarkdown } = await import('../src/attendance.js');
  const { cleanPresence } = await import('../src/iconText.js');
  const emails = ['akash8', 'namita', 'munira', 'tushar', 'umed', 'deep5', 'shubhankar', 'amalsamad678@gmail.com', 'neha3', 'swarangi', 'sunny3', 'nileshg', 'ravi7', 'shilpa', 'darshika', 'shrawin', 'vraj2', 'jayman', 'shubham21', 'pratul', 'akash9', 'mahaveer', 'mayuri', 'taha', 'radhika', 'ankur4'];
  const invited = emails.map((e, i) => ({ email: e.includes('@') ? e : `${e}@amnex.com`, status: i === 0 || e === 'shrawin' ? 'yes' : 'invited' }));
  const names = ['Akash Behera', 'Amal Samad', 'Akhil Azad', 'Ankur Desai', 'Deep Patel', 'Darshika Patel', 'Mahaveer Prajapati', 'Pratul Shah', 'Shrawin Sisodia', 'Shubham Chavan', 'Swarangi Gwali', 'Tushar Galiya'];
  const presence = {};
  names.forEach((n, i) => {
    presence[n] = [i * 3, 1000 - i, 5];
    presence[`More options for ${n}`] = [0, 660, 4]; // the same person, written the way Meet's menu button names them
  });
  presence['You can\'t remotely mute this participant'] = [0, 5, 1];
  const clean = cleanPresence(presence);
  assert.deepEqual(Object.keys(clean).sort(), [...names].sort(), 'one entry per person, no interface text');
  assert.equal(clean['Deep Patel'][0], 0, 'the earliest time wins');
  assert.equal(clean['Amal Samad'][1], 1000 - 1, 'the latest time wins');
  const m = matchPeople(invited, presence, { entries: [], myName: 'Shrawin Sisodia' });
  const seen = (e) => !!m.rows.find((r) => r.email === `${e}@amnex.com` || r.email === e)?.present;
  for (const e of ['tushar', 'swarangi', 'darshika', 'shrawin', 'pratul', 'mahaveer', 'deep5', 'shubham21', 'ankur4', 'amalsamad678@gmail.com']) assert.ok(seen(e), `${e} was in the meeting`);
  for (const e of ['namita', 'munira', 'umed', 'shubhankar', 'neha3', 'sunny3', 'nileshg', 'ravi7', 'shilpa', 'vraj2', 'jayman', 'mayuri', 'taha', 'radhika']) assert.ok(!seen(e), `${e} was not`);
  // two invitees share the first name akash: not guessable, and said so on both sides
  assert.ok(!seen('akash8') && !seen('akash9'));
  assert.deepEqual(m.rows.find((r) => r.email === 'akash8@amnex.com').mayBe, ['Akash Behera']);
  assert.deepEqual(m.uninvited.map((p) => p.name).sort(), ['Akash Behera', 'Akhil Azad']);
  assert.deepEqual(m.uninvited.find((p) => p.name === 'Akash Behera').couldBe, ['akash8@amnex.com', 'akash9@amnex.com']);
  assert.equal(m.uninvited.find((p) => p.name === 'Akhil Azad').couldBe, null);
  const md = attendanceMarkdown({ invited, presence, durationSec: 1100, entries: [], myName: 'Shrawin Sisodia' });
  assert.match(md, /10 of 26 invited people were seen in the meeting, plus 2 who could not be matched/);
  assert.match(md, /Akash Behera \| Not matched \| Yes .*could be akash8@amnex.com or akash9@amnex.com/);
  assert.match(md, /Akash \(akash8@amnex.com\) \| Accepted \| \*\*Absent\*\* .*may be Akash Behera/);
  assert.doesNotMatch(md, /More options|remotely mute/);
});

await test('attendance: addresses are shown as "Name (address)", names are learned safely and never flipped', async () => {
  const A = await import('../src/attendance.js');
  A.setEmailNames({});
  const invited = [{ email: 'deep5@amnex.com', status: 'invited' }, { email: 'amal.samad@amnex.com' }, { email: 'priya@x.com', name: 'Priya Nair' }];
  const m = A.matchPeople(invited, { 'Deep Patel': [0, 600, 3], 'Amal Samad': [0, 600, 3] }, { entries: [] });
  assert.equal(A.withAddress(m.rows[1]), 'Amal Samad (amal.samad@amnex.com)');
  assert.equal(A.withAddress(m.rows[0]), 'Deep (deep5@amnex.com)', 'a readable guess until the real name is known');
  const learned = A.learnEmailNames(m.rows);
  assert.deepEqual(learned, { 'deep5@amnex.com': 'Deep Patel', 'amal.samad@amnex.com': 'Amal Samad' });
  A.setEmailNames(learned);
  const next = A.matchPeople(invited, {}, { entries: [] });
  assert.equal(A.withAddress(next.rows[0]), 'Deep Patel (deep5@amnex.com)', 'next meeting knows the name even when Deep is absent');
  A.setEmailNames({});
  // what must NOT be remembered
  const row = (email, name) => ({ email, present: { name } });
  for (const [e, n] of [['a@x.com', 'Akash'], ['b@x.com', 'Unnamed voice 3'], ['c@x.com', 'Amal R.'], ['support@x.com', 'Support Lead'], ['d@x.com', 'Fireflies.ai Notetaker'], ['e@x.com', 'Conference Room'], ['f@x.com', 'You']]) {
    assert.deepEqual(A.learnEmailNames([row(e, n)]), {}, `${e} / ${n}`);
  }
  assert.deepEqual(A.learnEmailNames([row('rahul@x.com', 'Rahul Verma (Presenting)')]), { 'rahul@x.com': 'Rahul Verma' }, 'tile decoration is stripped');
  // one key per mailbox; hostile stored values do not crash the table
  assert.equal(A.emailKey(' Amal.Samad+meet@Gmail.com '), 'amalsamad@gmail.com');
  A.setEmailNames({ 'x@y.z': 5, 'constructor': 'x' });
  assert.equal(A.personLabel({ email: 'x@y.z' }), 'X');
  const md = A.attendanceMarkdown({ invited: [{ name: 'Pipe | Guy\nHeading', email: 'p@x.com' }, { name: 'Sam Lee sam.lee@x.com', email: 'sam.lee@x.com' }], presence: { Zed: [0, 50, 2] }, durationSec: 60, entries: [] });
  assert.match(md, /Pipe \\\| Guy Heading \(p@x.com\)/);
  assert.ok(!/sam.lee@x.com \(sam.lee@x.com\)/.test(md));
  A.setEmailNames({});
  const { inviteeEmails } = await import('../src/mailer.js');
  assert.deepEqual(inviteeEmails({ invited: [{ email: 'namita@amnex.com' }, { name: 'Deep Patel', email: 'deep5@amnex.com' }] }, { absentOnly: true, absentNames: ['namita@amnex.com'] }), ['namita@amnex.com']);
});

console.log(`\n${passed} passed`);
