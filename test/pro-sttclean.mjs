// Speech-to-text output that contains the model's own thinking, repeats and made-up speaker labels is cleaned; the spelling hints lose Meet's button text.
import assert from 'node:assert/strict';
import { stripThinking, dropRepeats, stripLabels, cleanTranscript, cleanTerms } from '../src/sttclean.js';

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

console.log(`\n${passed} passed`);
