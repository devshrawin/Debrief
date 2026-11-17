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
| **Speaker recognition accuracy** | **First real measurement (2026-10-15), one clip, three speakers, so treat it as a smoke test, not a benchmark.** Enrolled two people from about 22 s each of the user's own named clips. Of 190 other pieces in their two groups, 98% were named like the unsupervised grouping, 2% Unknown, 0 wrong (this part is circular: the groups come from the same fingerprints). Independent check: the user listened to 12 unlabelled pieces (2 to 4 s, mostly the risky short ones outside the two main groups): **10 of 10 named pieces were right, and the 2 pieces of a third, unenrolled voice were correctly left Unknown** (scores 0.19 and 0.31 against a 0.42 line; correct names scored 0.45 to 0.59). With n = 12 the 95% lower bound for the named pieces is about 70%. Not measured: more than three speakers, noisy rooms, laptop vs headset, overlap, Hindi as a separate stretch, a second meeting. |
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

## 8. Roadmap work, 2026-10-17

Test status after this work: all 16 suites in `npm test` pass (243 checks), `test/chrome-smoke.mjs` passes with no failures, and the new real-Chrome run `test/chrome-job.mjs` passes. Counts are from the run; "Verified" means seen working in headless Chrome, "Tested (synthetic)" means an automated test on made-up data.

| Task | What changed | State |
|---|---|---|
| Relay: no first-use window | `apps-script/Code.gs` v8: the install's secret is written on a `SECRET` line when the script is copied from Settings or the tour; with it set only that secret works from the first request; `doGet` returns only ok and the version. Setup text updated. | Tested (synthetic): `test/pro-relay.mjs` runs the real script on stubbed Google globals; a wrong secret is refused on a fresh relay. **Not tested on a real Apps Script deployment.** |
| Repo hygiene | `npm run pack` (store zip from a copy of `extension/` without the dev `key`), `npm run src-zip`, `.gitattributes` (LF), `.gitignore`. | Verified: zip contents checked, key absent in the store zip. |
| Store readiness | NOTICE.md cites WeSpeaker's own licence statement (CC-BY-4.0). Store manifest drops `key`. | Licence: verified on the project's page. `key`: **could not confirm** whether the store rejects it; it is left out of the store package. The store ID will differ from the pinned dev ID, so the Whisper and Ollama origin pins need the store ID (see `docs/STORE.md`). Model IDs: `gemini-3.5-transcribe` and `nova-3` confirmed in provider release notes; `gemini-3.8-flash` and `saaras:v4` only on third-party pages; nothing was changed. Loading the speaker model on demand was not done. |
| Fewer Gemini requests | Gemini with the mic on mixes mic and tab into one stream and sends one request per chunk; who spoke is worked out from 128 ms levels (`src/mixer.js`). Piece length setting (about 2 or 4 minutes). Popup warns when a one-hour meeting will not fit what is left of today's allowance. | Tested (synthetic): `test/pro-mix.mjs`. Attribution splits text by sentence in proportion to speaking time, so it is approximate. The warning needs a known daily limit (learned from a 429 or typed in). **The on-page pill does not show the warning. Needs a live Meet test.** |
| Minutes and email without a tab | `src/jobs.js` is the pipeline and the job runner; it runs in the offscreen document (storage through the service worker), job state is on the meeting (`queued`, `transcribing-retry`, `writing`, `emailing`, `done`, `failed`), the 10 s countdown runs there and touching the page holds it, stuck jobs resume when the service worker starts, the automatic email is sent once (lock, `emailedAt`, and a "sending" mark). `mom.js` is a viewer and runs the same code itself only if no runner answers. | Tested (synthetic): `test/pro-jobs.mjs`, 9 cases. Verified in real Chrome (`test/chrome-job.mjs`): minutes written with no minutes tab, a stuck job resumed after the service worker was closed, one model call for two page opens, the background document closes when done. **Not verified in a real browser: the automatic email itself** (the relay URL cannot be faked), and a real laptop sleep or Chrome quit. |
| One control per choice | Format switch only on the page (the start card shows it as text), one transcript checkbox for my email and one in Share, "Write minutes" / "Rewrite minutes" everywhere. | Verified in `chrome-smoke.mjs`; no old button names remain in `src`, the page or the docs. |
| Shorter tour | Key, microphone, then "You are ready"; name, names, voices, email, sharing, local models and limits are an optional "Set up more" list. Settings → Get started links to the tour. | Verified in `chrome-smoke.mjs`. |
| Honest labels | Speaker names, captions and attendance are Meet only. The task said other apps have no mute follow; they do, best effort, through the generic adapter, so the text says that. The popup shows a one-line hint on known other apps. | Tested (synthetic). |
| Organisation template | Name, footer line, accent colour and email domains are Settings; "Use Amnex preset" fills them. New installs are generic and use the standard format. Existing installs are migrated once (schema 2) and keep the Amnex format and values. The shipped `print.css` is generic; the page adds the organisation's footer line. | Tested (synthetic): `test/pro-amnex.mjs` (generic, custom, preset, injection, migration). The button is verified in `chrome-smoke.mjs`. |

### Still needs a live test by a person

- A real Google Meet call: mic and tab mixed into one request, "me" and "others" attribution, follow-Meet-mute.
- Automatic email after closing every Debrief tab, and after a Chrome restart.
- The quota warning with a real daily limit.
- Speaker recognition accuracy (unchanged by this work).
- Deploying the v8 relay script and sending a test email.

## 9. Version 1.4.0, 2026-11-16 and 17

Built in one pass from an audit against Claude Meetings (Anthropic's meeting feature) and of this codebase. "Tested (synthetic)" means automated tests on made-up data with fake providers; "Verified in Chrome" means seen working in headless Chrome with fake servers. **Nothing in this section has been tried on a live call, with a real provider key, or against the real Google Meet page.**

Test status: `npm test` 45 suites, 713 checks, all pass. Real Chrome: chrome-job, chrome-minutes, chrome-meet, chrome-settings, chrome-live, chrome-panel, chrome-smoke, chrome-gaps, chrome-voices, chrome-glass all pass (one tour check in chrome-smoke is timing-sensitive and occasionally needs a rerun).

| Change | State |
|---|---|
| Storage split (META + chunked lists), stale-copy protection for lists and META fields, locks across contexts | Tested (synthetic) incl. byte counts: an append writes about 1.4 KB instead of the whole meeting; a heartbeat on a two-hour meeting writes 2.3 KB instead of 5.3 MB. Verified in Chrome through the job and minutes suites. Not verified: a real three-hour recording, a real service-worker restart mid-call. |
| Structured minutes with classic fallback, cut-off answer detection | Tested (synthetic) with fake models only. **No real model has produced these minutes yet**: quality against the classic pipeline is unknown until `npm run eval` is run on real meetings (docs/EVAL.md). |
| Action tracking, carry-over between meetings of a series, Open actions page | Tested (synthetic); pages verified in Chrome. |
| Real per-line times (Deepgram, Whisper-style) | Tested (synthetic) on the providers' documented response shapes. Not called against the live services. Gemini and Sarvam still estimate times inside a piece. |
| Live transcript page | Verified in Chrome with fake broadcasts and seeded storage. Not verified on a real recording. |
| Kept recording, play a line, read a stretch again | Verified in Chrome with one-second test tones. Not verified: seeking inside real 30 s segments, storage quota behaviour, long meetings. |
| Shared-screen notes | Tested (synthetic). Not verified: real tab video capture next to audio capture, a real vision model, thresholds on real slides. |
| Chat notice, record reminder, presenting detection | Tested on hand-made Meet markup only. **The selectors are educated guesses**: check "Check page detection" (chat and presenting lines) on a live call. |
| Sharing guard, webhook, backup and restore, model-name check | Tested (synthetic); Settings flows verified in Chrome. Not verified: real Slack/Teams webhooks, real provider model lists, a real permission prompt. |
| Lite package (speaker model downloaded on first use) | Packaging verified (4.2 MB against 28.9 MB). Download path tested (synthetic). Chrome Web Store acceptance unknown. |
| Independent reviews | Three code reviews (storage and jobs; security and privacy; capture pipeline) found 2 + 1 + 1 high and about 20 lower findings; all fixed with regression tests, except the items under "Left as is". UI reviewed from screenshots by a separate model; see the final report of this work for the verdict. |

### Left as is, on purpose
- The floating panel and the popup both stay: the popup is the fallback on pages that cannot be scripted, so neither can be removed.
- `third_party/libraries-dev` stays: the effects build imports it.
- `popup.html` is still web-accessible (the floating panel needs it); a hostile page could frame it. Not changed here.
- Automatic start of a recording is not possible: Chrome only allows tab capture after a click on the extension or its shortcut. The reminder can only ask.
- Trims work in whole chunks (captions keep 4,000 to 4,199; voice pieces 12,000 to 12,399). Up to 15 s of "last seen" times can be lost if the service worker dies mid-call.

### Still needs a live test by a person (adds to the list above)
1. Record a real Meet call with **Short pieces** on and the Live page open: lines arrive, summary so far, Ask.
2. With Deepgram or Groq Whisper: check a few line times against the kept recording.
3. **Keep the recording** on: play lines from the transcript and from `[mm:ss]` in the minutes; "Read this part again" across a pause.
4. **Shared screen** on while someone presents slides: notes appear as "On screen" rows and figures reach the minutes; watch the request count in Usage.
5. **Recording notice** on: the line appears in Meet chat once; with chat disabled you are told.
6. A meeting that matches a meeting type: the reminder card appears, not in a one-to-one.
7. Two meetings of the same series: the second reviews the first one's open actions.
8. Structured against Classic on the same real transcript (Settings → Minutes), and `npm run eval -- --live` on your own reference meetings.
9. Back up, restore on another Chrome profile, confirm nothing changes where data goes unless ticked.
10. Webhook to a real Slack or Teams address, allowing and then refusing the permission.
