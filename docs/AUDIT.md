# Debrief Pro: end-to-end audit (2026-10-14)

Branch `pro`. "Verified" means I ran it and saw the result in this session. "Tested (synthetic)" means an automated test passes on made-up data, which proves the logic and says nothing about real-world accuracy. "Not verified" means nobody has seen it work on a real call.

## 1. What was measured today

| Check | Result |
|---|---|
| Node test suites (11 files) | 151 tests pass |
| Headless Chrome smoke test (`test/chrome-smoke.mjs`) | 46 checks pass, 0 fail, no uncaught page errors (one run had a network-timing flake in the bad-key tour check; it passed on rerun) |
| Speaker model in a real Chrome worker | loads in about 0.3 s, one 1.5 s piece in about 0.3 s, reproduces the Python reference fingerprint (cosine 0.9999) |
| Clip through the real transcription code (23.9 min, 15 chunks) | 67 requests, **49 failed** (nearly all rate limits), 6 models tried per chunk, chunk 5 came back empty, no looped output, only chunks 2 and 3 are mostly Malayalam script |
| Extension size | 42 MB (26.5 MB speaker model, 14 MB WebAssembly runtime, 3 MB of page code) |

## 2. Working (verified by the automated tests)

- Recording plumbing: start/stop, one recording at a time, auto-stop on meeting end and on long silence, level meters, queued audio retried when quota returns.
- Gemini / Sarvam / Deepgram / Whisper-compatible speech-to-text with the model fallback chain, language hints, noise and loop filtering.
- Minutes: extract, write, audit; dictionary and attendee name correction; learned names; attendance; Ask-your-meetings.
- Email relay v6 (secret lock, allow-list, calendar lookup). The Workspace URL form (`/a/macros/domain/s/…/exec`) is now accepted.
- Sharing, local-model presets, usage page (now with a "cost if paid" estimate), first-run tour (12 steps).
- Meet adapter: participants (icon-font names such as `frame_person` are now ignored), captions, mute button (now also in non-English Meet).
- Voice: speech tracker, fingerprints, matching, smoothing, overlap becomes "unknown", alignment to transcript sentences, merge with captions, enrolment, export/import, learning (captions-based and recurring voices), forget-all.

## 3. Not working, weak, or unmeasured

| Item | State |
|---|---|
| **Gemini quota** | Free tier runs out: the chain wastes most requests on models already over their daily limit. Today's key is probably exhausted (my clip run used it). Needs a per-model cooldown (see cheap wins). |
| **Speaker recognition accuracy** | **Never measured on real people.** Thresholds (accept 0.42, margin 0.07) came from a small amount of real speech. No error rate, no cross-language (English vs Hindi vs Malayalam) number. |
| **Sentence-to-speaker alignment** | Transcript has no word times, so sentences are spread over speech time by length. Error unknown; speaker changes can be off by seconds. |
| **Mic follows Meet mute** | Logic and tests exist; your last meeting showed the mic at exact silence with no log of why. Logging added, **not re-verified live**. |
| **Malayalam / Hindi transcription quality** | Baseline shows Hindi often comes out Roman-script and fallback models add `mm:ss` prefixes. No before/after comparison yet. |
| **Part 3 (cluster the clip, enrol 2–3 people, measure agreement)** | Not done: needs you to say who is who and a working Gemini quota. |
| **Part 4 (English+Malayalam fixes with before/after)** | Proposals only (section 6). Nothing applied to defaults. |
| **Minutes run on the clip** | Not run. |
| **Learning voices** | Tested (synthetic) only. Merge/split mistakes are possible and there is no automatic merge. |
| **Model licence** | NOTICE says CC-BY-4.0 for the WeSpeaker ResNet34 model; **please verify against the project's page before distributing**. |

## 4. What I can QA by myself, and what I can't

**I can (and did):** logic, storage, prompts, UI rendering in headless Chrome, the speaker model in a Chrome worker, the pipeline on a recorded clip (needs working Gemini key and quota), build and size checks, regression after each change.

**I cannot:** anything needing a real person, a real microphone, a live meeting, or your accounts.

## 5. Your checklist (things only you can do)

1. **Quota:** open Usage; if models show "0 of 20", wait for the Pacific-midnight reset before testing.
2. **Mic follow:** join a Meet, start Debrief, speak unmuted, mute in Meet and speak, unmute and speak. After stopping, open the minutes page → debug lines: expect `Meet mic: muted/unmuted …`. Popup → *Check page detection* should show the mic state. If the mic stays silent, expect the "Your microphone is silent" alert.
3. **Enrolment:** Settings → Voices: add yourself (English) and one colleague (Hindi or Speak freely). Check the meter moves, playback sounds right, saving works, the list shows the person. Restart Chrome and confirm they are still there.
4. **Voice naming on a real meeting:** turn on *Name speakers by their voice*, record a meeting with the enrolled person speaking, open the minutes page. Count how many lines are named right / wrong / unknown. This is the accuracy number I cannot produce.
5. **Learning:** turn on *Learn who is who* for two meetings. After each, Voices should list "Unnamed voice N". Rename one; confirm the next meeting shows that name.
6. **Delete / forget:** delete one person, then *Forget all voices*; confirm the list empties.
7. **Export/import:** export, import on another Chrome profile; check the name appears.
8. **Email:** redeploy script as "Anyone", paste the `/exec` URL, press test email; then record a short meeting and check the email, the PDF, the Word file, and the transcript attachment (names, Hindi characters).
9. **Zoom / Teams in the browser:** amber glow when a call starts, mute follow, end-of-call stop.
10. **Another computer:** install from the folder, run the tour, confirm nothing needs your settings.
11. **Listening checks:** pick three lines labelled with a name and listen to the recording at that time.

## 6. Cheap wins

Done (2026-10-14, after the first audit), each with automated tests:
1. **Per-model cooldown after a 429**: a Gemini model that has just reported its limit is skipped until it can answer (until the Pacific-midnight reset for daily limits, or the retry time Google gives). When every model is exhausted the chunk fails at once and the audio stays queued instead of minutes of back-off.
2. **Timestamps stripped** from fallback transcripts (`00:04Child Development…`).
3. **Anthropic SDK replaced by `fetch`**: the options, minutes, Ask and tour pages are 5 to 10 times smaller (for example options 652 KB to 92 KB, minutes 730 KB to 172 KB).
4. **Never learn this voice again** when deleting a learned voice, and **Merge into…** for two learned voices that are one person.
5. **Check my setup** panel (Get started page): keys, today's quota, models resting, microphone, mute follow, email relay version, voices, and what happened in the last meeting. Safe to paste: it never prints a key.
6. **The popup says what it sees of the call's mute button.**
7. **Regenerating the minutes reuses the items found the first time** (temperature 0 for extraction and the check), with a Re-read transcript button.

Still open:
- **Bigger audio chunks** (about 240 s instead of 100 to 150 s): fewer requests on a free tier of about 25 a day, but it needs a before/after on the clip (loops, missed speech) and a working quota, so the default is unchanged.
- Voices page screenshot in the README.
- Quota warning at the start of a recording (the popup already warns at 80% while recording).

## 7. Risks to keep in mind

- Voice fingerprints identify people: tell colleagues, keep learning off unless wanted, and share exports only with consent.
- The email relay URL works for anyone who has it until the first call sets its secret. Test straight after deploying.
- The extension is 42 MB. Chrome Web Store allows it, but installs are heavier than before.
- Real accuracy of everything voice-related is unknown until section 5, step 4 is done.
