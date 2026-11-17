// Regression tests for the content-script / recorder review (fixes 1-9): speech that looks like a reasoning opener is kept,
// verbose_json memo, recorder teardown, pause, content-script cost, timeline reads, screen-note budget, query expansion.
import assert from 'node:assert/strict';

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

// ---- 1. real speech is not taken for leaked thinking ------------------------------------------------------------
const { stripThinking, cleanTranscript, isLegacyCapture } = await import('../src/sttclean.js');
const { formatTranscript } = await import('../src/prompt.js');
const { LiveStore } = await import('../src/livelogic.js');

const SPEECH = [
  "Let's check the numbers for Q3.",
  'Rules: no phones in the room.',
  'The user wants a faster export.',
  'Wait, the budget is approved?',
  "OK so let's check the numbers for Q3 before we go.",
  'चलो Q3 के numbers check करते हैं. Wait, the budget approve हो गया क्या?',
  'Rules: मीटिंग में फोन नहीं. The user wants faster export, ठीक है?',
  'നമുക്ക് Q4 numbers നോക്കാം. Let\'s check the vendor invoices for Q4.',
  'Wait, the budget approve ആയോ? Let\'s re-listen to the clip.',
];

await test('speech that starts like a reasoning block is kept whole by stripThinking and cleanTranscript', () => {
  for (const s of SPEECH) {
    assert.equal(stripThinking(s).leaked, false, s);
    assert.equal(cleanTranscript(s, []).text, s, s);
    assert.equal(cleanTranscript(s, [], null, { thinking: false }).text, s, s);
  }
});

await test('speech with a reasoning opener is kept at display: formatTranscript (old and new meetings) and LiveStore', () => {
  for (const startedAt of [Date.parse('2026-10-01'), Date.parse('2026-11-10')]) {
    const out = formatTranscript({ startedAt, segments: SPEECH.map((text, i) => ({ t: i * 10, src: 'others', text })) }, 'Me', {});
    for (const s of SPEECH) assert.ok(out.includes(s), `${startedAt}: ${s}\n${out}`);
  }
  const st = new LiveStore();
  st.add('segment', SPEECH.map((text, i) => ({ t: i * 10, src: 'others', text })));
  assert.deepEqual(st.rows.map((r) => r.text), SPEECH);
});

await test('real leaked thinking is still removed (end marker, several markers, echoed instructions)', () => {
  const leak = 'ठीक है, one more task अह The user wants a transcription of the meeting audio. Rules:\n- Exact transcription as spoken.\nAudio breakdown:\n0:00 - 0:05: Mahaveer.\nLooks very solid!So we need to import that database.';
  assert.equal(cleanTranscript(leak).text, 'ठीक है, one more task अह So we need to import that database.');
  assert.equal(cleanTranscript('Okay noted. The user wants a transcription of the audio with speaker labels. Final answer: Okay noted again, thanks.').leaked, true);
  const noEnd = 'Let\'s check the audio. Rules: transcribe exactly, no speaker labels. Is it "SeVa" or "SAVI"? The user wants the exact words, and then there is a very long reasoning passage that goes on and on.';
  assert.equal(cleanTranscript(noEnd).text, '');
});

await test('legacy meetings (before 1.1.2) are the only ones cleaned for thinking again at display', () => {
  assert.equal(isLegacyCapture({ startedAt: Date.parse('2026-10-01') }), true);
  assert.equal(isLegacyCapture({}), true);
  assert.equal(isLegacyCapture({ startedAt: Date.parse('2026-11-10') }), false);
  const leak = 'Real words first. The user wants a transcription of the meeting audio. Rules: exact words. Audio breakdown: 0:00 - 0:05: hi. Looks good! Final words.';
  const seg = [{ t: 1, src: 'others', text: leak }];
  assert.ok(!/The user wants/.test(formatTranscript({ startedAt: Date.parse('2026-10-01'), segments: seg }, 'Me', {})));
  assert.ok(/The user wants/.test(formatTranscript({ startedAt: Date.parse('2026-11-10'), segments: seg }, 'Me', {})), 'cleaned at capture, not again');
});


console.log(`\n${passed} passed`);
