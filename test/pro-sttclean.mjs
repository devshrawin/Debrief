// Speech-to-text output that contains the model's own thinking, repeats and made-up speaker labels is cleaned; the spelling hints lose Meet's button text.
import assert from 'node:assert/strict';
import { stripThinking, dropRepeats, stripLabels, cleanTranscript, cleanTerms, makeDeduper, looksTransliterated, latinShare } from '../src/sttclean.js';
import { formatTranscript } from '../src/prompt.js';

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

const FINAL = 'So basically हमारा जो golden record table है, ठीक है? So we need to import that particular cluster database within the SDC environment।';
const LEAKED = `ठीक है, one more task अह The user wants a transcription of the meeting audio. Rules:\n- Exact transcription as spoken.\n- Use provided spellings for specific names/terms: Mahaveer, Tushar, etc.\nAudio breakdown:\n0:00 - 0:05: Mahaveer. So basically Mahaveer, Tushar.\nIs it "SeVa" or "SAVI" or "CEVI"? Wait, is it in the list? List: "Backgrounds and effects, You can't remotely mute this participant, More options for Akash Behera"\nLooks very solid!${FINAL}`;

await test('thinking that leaked into a transcript is cut: what came before and the final answer stay, the rest goes', () => {
  const r = stripThinking(LEAKED);
  assert.equal(r.leaked, true);
  assert.ok(r.text.startsWith('ठीक है, one more task अह'), r.text);
  assert.ok(r.text.endsWith('SDC environment।'), r.text);
  for (const bad of ['The user wants', 'Rules:', 'Audio breakdown', 'Is it "SeVa"', 'More options for', 'Backgrounds and effects']) assert.ok(!r.text.includes(bad), bad);
});

await test('a transcript that merely mentions times or rules in speech is left alone', () => {
  const t = 'ठीक है, meeting 3:00 बजे है. The rules are simple. Is it ready? Let us check the numbers.';
  assert.equal(stripThinking(t).leaked, false);
  assert.equal(cleanTranscript(t).text, t);
});

await test('repeated sentences inside one piece are said once', () => {
  const s = 'So we need to import that particular cluster database within the SDC environment. हां, second half में कर सकते हैं। So we need to import that particular cluster database within the SDC environment.';
  assert.equal(dropRepeats(s).match(/cluster database/g).length, 1);
  assert.equal(dropRepeats('ठीक है। ठीक है।'), 'ठीक है। ठीक है।', 'short repeats are real speech');
});

await test('speaker labels the model made up are removed, only for people we know', () => {
  const names = ['Deep Patel', 'Vivek Pawar'];
  assert.equal(stripLabels('Deep Patel: ठीक है। Vivek Pawar: ओके। I met Deep Patel on Friday.', names), 'ठीक है। ओके। I met Deep Patel on Friday.');
  assert.equal(stripLabels('Note: this is fine', names), 'Note: this is fine');
});

await test('spelling hints: Meet button text is dropped and "More options for X" becomes X', () => {
  const out = cleanTerms(['Backgrounds and effects', "You can't remotely mute this participant", 'More options for Akash Behera', 'Open in new window', 'Namita Uzagare', 'frame_person', 'akash behera', 'Unified Registry']);
  assert.deepEqual(out, ['Akash Behera', 'Namita Uzagare', 'Unified Registry']);
});

const NOTES = `Silent audio track (only background noise, clicks, tones).
- Output: Nothing (empty string).`;
const BREAKDOWN = `Analyse the audio:
- 00:00 - 00:46: Male speaker discussing timeline, drafting user manual, VAPT.
- 01:34 - 01:42: Malayalam spoken:
Female 1: "ധന്യ" (Dhanya?)
Keywords to check: KSITM, Dhanya Wait, in Malayalam she says: "ധന്യ" -> "ആ നമുക്ക് നാളെ ചെയ്യണം കേട്ടോ"Okay. And we will start drafting. It will take 2 days.`;

await test('notes about the audio are dropped; a piece that is only notes becomes empty', () => {
  const r = cleanTranscript(NOTES);
  assert.equal(r.text, '');
  assert.equal(r.leaked, true);
  assert.equal(cleanTranscript('Ordinary words, nothing else.').leaked, false);
});

await test('a breakdown by time ranges is dropped and the real words glued to the end of it are kept', () => {
  const r = cleanTranscript(BREAKDOWN);
  assert.equal(r.text, 'Okay. And we will start drafting. It will take 2 days.');
});

await test('an opening quote is never taken for the start of the real words', () => {
  const t = 'Output: Nothing\n- "So if I select monetary it will be..."\n- "frequency of distribution..."\nOkay. Real words here.';
  assert.equal(cleanTranscript(t).text, 'Okay. Real words here.');
});

await test('speaker labels the model invented (Speaker 1, Female voice) go, with the quotes they carried; real quotes stay', () => {
  assert.equal(cleanTranscript('Speaker 1 (female, Malayalam): "Okay, suppose it is not there."\nSpeaker 2: "Correct."').text, 'Okay, suppose it is not there. Correct.');
  assert.equal(cleanTranscript('Female voice: Anything from the team?').text, 'Anything from the team?');
  assert.equal(cleanTranscript('We have speech segments in Malayalam and English. So the schedule holds.').text, 'So the schedule holds.');
  assert.equal(cleanTranscript('He said "go ahead" and left.').text, 'He said "go ahead" and left.');
  assert.equal(cleanTranscript('Akash: "Correct, correct. Okay."', ['Akash']).text, 'Correct, correct. Okay.');
});

await test('a run of video offsets inside the words is removed; a time in speech is kept', () => {
  assert.equal(cleanTranscript('0:11uh So, 0:13the first step 0:18selection of 0:25the type').text, 'uh So, the first step selection of the type');
  assert.equal(cleanTranscript('We meet at 4:50 and again at 5:30 sir.').text, 'We meet at 4:50 and again at 5:30 sir.');
  const agenda = 'The agenda is 9:00 registration, 10:00 opening, 11:00 break, 12:00 lunch, 1:00 sessions and 4:50 close.';
  assert.equal(cleanTranscript(agenda).text, agenda, 'times read out from an agenda are speech');
  assert.equal(cleanTranscript('0:01 So 0:06we begin 0:11here and 0:13then 0:18go on').text, 'So we begin here and then go on', 'a leading offset goes with the run');
});

await test('a passage written again in the next piece is dropped, also when the fillers differ; short repeats and first sightings stay', () => {
  const dd = makeDeduper();
  const one = 'So, because this VAPT part is part of milestone number 5, where we have to go ahead and do the security audit. Okay.';
  const two = 'So because this VAPT part is part of Milestone number 5, where we have to go ahead and do the security audit, uh. Okay. Then something new is said about the user manual here.';
  assert.equal(cleanTranscript(one, [], dd).text, one);
  const r = cleanTranscript(two, [], dd).text;
  assert.ok(!r.includes('VAPT'), r);
  assert.ok(r.includes('Okay.') && r.includes('something new'), r);
  assert.equal(cleanTranscript('Okay. Yes. Sure, sure.', [], dd).text, 'Okay. Yes. Sure, sure.', 'short phrases repeat in real speech');
  assert.equal(cleanTranscript(one).text, one, 'without a deduper nothing is remembered');
});

await test('English written in Malayalam letters is recognised; mixed text and short text are not', () => {
  const translit = 'ദിസ് ഫ്യൂ സ്റ്റെപ്പ്സ് ദ സ്‌കീം ഡീറ്റെയിൽസ് പാർട്ട് വുഡ് ബി കമ്പ്ലീറ്റഡ് അൻഡ് ഓൾസോ വീ ഹാവ് ദിസ് ഷോ ആൻഡ് ഹൈഡ്. '.repeat(10);
  assert.equal(looksTransliterated(translit), true);
  assert.equal(looksTransliterated(`${translit} and then the scheme details part would be completed, okay`.slice(0, 200)), false, 'short');
  const mixed = 'ഇത് ഇങ്ങനെ തന്നെ the scheme details part would be completed and we continue. '.repeat(14);
  assert.equal(looksTransliterated(mixed), false);
  assert.ok(latinShare(mixed) > 0.5);
  assert.equal(latinShare(''), 0);
});

await test('what the minutes writer reads is the cleaned transcript: no notes, a passage said twice once', () => {
  const meeting = {
    segments: [
      { t: 3, src: 'others', text: 'Silent audio track (only background noise).\n- Output: Nothing\nSo because this VAPT part is part of milestone number 5 we will run it later. Okay.' },
      { t: 60, src: 'others', text: 'So, because this VAPT part is part of Milestone number 5, we will run it later, uh. Then the user manual follows.' },
      { t: 70, src: 'me', text: 'Analyse the audio:\n- 00:00 - 00:10: Male speaker.\nNoted, thank you.' },
    ],
  };
  const out = formatTranscript(meeting, 'Akash', {});
  assert.ok(!/Silent audio|Analyse|Output:|00:00 - 00:10/.test(out), out);
  assert.equal((out.match(/VAPT part/g) || []).length, 1, out);
  assert.match(out, /\[01:00\] OTHERS: Then the user manual follows\./);
  assert.match(out, /\[01:10\] ME \(Akash\): Noted, thank you\./);
});

await test('a sentence that differs in a date, a number, a name or a "not" is a different sentence, not a repeat', () => {
  const pairs = [
    ['The second cycle of testing will be completed by the sixth of November this year after review.', 'The second cycle of testing will be completed by the seventh of November this year after review.'],
    ['We will start the user acceptance testing with the department on Monday morning after the walkthrough.', 'We will start the user acceptance testing with the department on Friday morning after the walkthrough.'],
    ['We will conduct the security audit before the soft launch of the department portal next month for sure.', 'We will not conduct the security audit before the soft launch of the department portal next month for sure.'],
    ['The treasury integration covers two social welfare schemes and five lakh beneficiaries in the first phase.', 'The treasury integration covers two social welfare schemes and four lakh beneficiaries in the first phase.'],
    ['Please send the signed documents to Aparna by tomorrow so that the review can start on time again.', 'Please send the signed documents to Dhanya by tomorrow so that the review can start on time again.'],
    ['Cycle 1 of the VAPT takes 5 days from the ninth of November onwards for the department portal.', 'Cycle 1 of the VAPT takes 6 days from the ninth of November onwards for the department portal.'],
  ];
  for (const [a, b] of pairs) {
    const dd = makeDeduper();
    assert.equal(cleanTranscript(a, [], dd).text, a);
    assert.equal(cleanTranscript(b, [], dd).text, b, `kept: ${b}`);
  }
});

await test('the same sentence with other fillers, articles and capitals is a repeat', () => {
  const pairs = [
    ['Uh and then we have the SRS and design documents for the department portal.', 'Uh then we have the SRS and the design documents for the department portal.'],
    ['But only for this soft launch of department portal is getting extended till 24th of November.', 'Only for this uh soft launch of department portal is getting extended till 24th of uh November.'],
    ['Ma\'am, the only concern uh which we have as system integrator is the revised end date.', 'Yes, ma\'am, the only concern which we have as system integrator is the revised end date.'],
  ];
  for (const [a, b] of pairs) {
    const dd = makeDeduper();
    assert.equal(cleanTranscript(a, [], dd).text, a);
    assert.equal(cleanTranscript(b, [], dd).text, '', `dropped: ${b}`);
  }
});

console.log(`\n${passed} passed`);
