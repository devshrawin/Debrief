# Evaluating Debrief on real meetings

Unit tests prove the code runs. They do not tell you whether a prompt or model change made transcripts or minutes
better on the meetings you care about. The eval harness in `test/eval/` scores both against a small golden set of your
own meetings, so a change can be measured instead of guessed at.

The bundled `test/eval/sets/sample/` is synthetic and only proves the harness works. Its numbers mean nothing about Debrief.

## Add a real case

1. Record a meeting (or a 5 to 15 minute stretch of one) and keep the audio if you want to test transcription: 16 kHz, mono, 16-bit WAV, saved as `audio.wav`.
2. Export the transcript Debrief stored for it as `transcript.json`: `[{ "t": seconds, "src": "me" | "others", "text": "..." }]`.
3. Copy that text to `reference.txt` and correct it by hand until it is what was actually said. Write each language in the script you want to be scored against (for example Devanagari for Hindi words, Latin for English).
4. Write `reference.items.json` by listening: `{ "actions": [{ "text", "owner", "due", "at" }], "decisions": [{ "text", "at" }] }`. `owner`, `due` and `at` (`mm:ss`) are optional; leave out what you are unsure of. `risks` and `questions` are accepted but not scored yet.
5. Add `case.json`: `{ "title", "languages": ["hi","en","ml"], "attendees": [...], "notes": "..." }`.
6. Optional: `minutes.md`, a previously produced minutes file, so offline runs can score it.

Put each case in its own folder under a set directory, for example `test/eval/sets/mine/<case>/`. Meeting content is private: keep real sets out of git.

## Commands

```
node test/eval/selftest.mjs                      # tests of the harness itself
node test/eval/run.mjs                           # offline, sample set
node test/eval/run.mjs --set test/eval/sets/mine # offline: score the files already in each case
GEMINI_API_KEY=... node test/eval/run.mjs --set test/eval/sets/mine --live --out test/eval/out
```

Options: `--stage stt|minutes|all`, `--out dir` (default `test/eval/out`, git-ignored), `--baseline report.json`,
`--fail-under-f1 0.6`, `--fail-over-wer 0.5`. Exit code 1 when a `--fail-*` limit is crossed, 2 for bad usage or a missing key.

`--live` runs the real pipeline: `audio.wav` is cut by the real `Chunker` and sent through `transcribe` (stt stage), and the
transcript is sent through `writeMinutes` with the real LLM client (minutes stage). Outputs go to `--out/<case>/`. Without an
`audio.wav` the stored `transcript.json` is used. Settings come from the extension defaults plus `GEMINI_API_KEY`; set
`DEBRIEF_SETTINGS=path/to/settings.json` to override any of them (models, providers, `minutesMode`, other keys).
It spends API quota.

## Reading the numbers

- **WER** word error rate and **CER** character error rate against `reference.txt`, after lowercasing and stripping punctuation. Lower is better. Watch CER for Hindi and Malayalam: spelling and word splitting vary, so WER alone overstates the errors.
- **Dev%** share of the transcript's letters that are Devanagari. Compare with the reference to catch English written in Devanagari, or Hindi written in Latin.
- **F1, P, R** how well the minutes' action items and decisions match the reference, paired one to one by word overlap (threshold 0.4). Recall is "did it catch them", precision is "did it invent extras". Missed and extra items are listed under each case.
- **own%, due%** among matched actions, how often the owner (first name counts) and due date (loose compare) agree with the reference.
- **tsErr** mean seconds between the reference and the minutes' timestamps for matched items.

Item matching is a text heuristic, so a differently worded but correct item can count as missed. Read the missed and extra lists before trusting a drop.

## What good looks like

Unknown until you have a set of your own. Do not borrow targets from elsewhere: results depend heavily on your audio, speakers and
language mix. Build the set, record the first numbers as your starting point, and judge changes against that.

## Workflow

1. Run `--live` on your set and keep the report: `cp test/eval/out/report.json test/eval/baseline.json`.
2. Change a prompt, a model or a setting.
3. Rerun with `--baseline test/eval/baseline.json`. Deltas are in percentage points. A case is flagged REGRESSION when WER rises by more than 2 points or F1 falls by more than 3.
4. Use `--fail-under-f1` / `--fail-over-wer` once you know sensible limits for your set.

A small set is noisy: with a handful of actions per case, one item moves F1 by many points. Add cases before reading much into a change.
