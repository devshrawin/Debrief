// Pure helpers behind the 1.4 Settings controls: number clamping, backup file name and summary, webhook test body, share-guard note.
import assert from 'node:assert/strict';
import { NUMERIC, clampNum, backupFileName, formatMB, plural, describeBackup, webhookTestBody, originPattern, guardCannotTell, modelFieldFor } from '../src/settingslogic.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
};

test('clampNum keeps numbers in range and falls back when empty', () => {
  assert.equal(clampNum('999', NUMERIC.keepAudioDays), 365);
  assert.equal(clampNum('-3', NUMERIC.keepAudioDays), 0);
  assert.equal(clampNum('', NUMERIC.keepAudioDays), 14);
  assert.equal(clampNum('x', NUMERIC.screenNotesEverySec), 30);
  assert.equal(clampNum(1, NUMERIC.screenNotesEverySec), 10);
  assert.equal(clampNum('45.6', NUMERIC.screenNotesEverySec), 46);
});
test('backup name, sizes and plurals', () => {
  assert.equal(backupFileName(new Date(2026, 0, 5)), 'debrief-backup-2026-01-05.json');
  assert.equal(formatMB(0), '0 MB');
  assert.equal(formatMB(11 * 1048576), '11 MB');
  assert.equal(formatMB(1572864), '1.5 MB');
  assert.equal(plural(1, 'meeting'), '1 meeting');
  assert.equal(plural(0, 'meeting'), '0 meetings');
});
test('describeBackup reads what a file holds without trusting it', () => {
  assert.deepEqual(describeBackup({ app: 'debrief', meetings: [1, 2], settings: {}, voices: [1] }), { meetings: 2, settings: true, voices: 1 });
  assert.deepEqual(describeBackup({ app: 'debrief', meetings: 'x', settings: [] }), { meetings: 0, settings: false, voices: 0 });
  assert.equal(describeBackup({ hello: 1 }), null);
  assert.equal(describeBackup(null), null);
});
test('webhook test body: JSON for tools, text for Slack and Teams', () => {
  assert.deepEqual(webhookTestBody('https://example.com/h'), { app: 'debrief', version: 1, event: 'test' });
  assert.ok(typeof webhookTestBody('https://hooks.slack.com/services/x').text === 'string');
  assert.equal(originPattern('http://127.0.0.1:8080/hook'), 'http://127.0.0.1:8080/*');
});
test('share guard note: only when there is nothing to compare with', () => {
  assert.equal(guardCannotTell({ guard: true, myOrgDomains: '', emailTo: '' }), true);
  assert.equal(guardCannotTell({ guard: true, myOrgDomains: '', emailTo: 'a@gmail.com' }), true);
  assert.equal(guardCannotTell({ guard: true, myOrgDomains: '', emailTo: 'a@company.com' }), false);
  assert.equal(guardCannotTell({ guard: true, myOrgDomains: 'company.com', emailTo: '' }), false);
  assert.equal(guardCannotTell({ guard: false, myOrgDomains: '', emailTo: '' }), false);
});
test('model findings map to their field', () => {
  assert.equal(modelFieldFor({ role: 'minutes', provider: 'gemini' }), 'geminiModel');
  assert.equal(modelFieldFor({ role: 'speech', provider: 'openai' }), 'sttModel');
  assert.equal(modelFieldFor({ role: 'fallback', provider: 'gemini' }), '');
});
console.log(`${passed} passed`);
