# Debrief 1.4.0: session notes

How the `fable-daddy` branch of **devshrawin/Debrief** was built: what was asked, what was done and in what order, how the work was organised and checked, and what is still open.

Dates: 16 to 19 November 2026.
Branch: `fable-daddy`. Last pushed commit: `69916c2` ("Regenerate screenshots after audit round 2 fixes").

---

## 1. The conversation, in order

### 1.1 "Tell me about Claude meetings"
- The Claude Meetings connector was checked. The meetings list was empty: Claude had not been sent to any meeting.
- The feature was explained from the connector's own description:
  - Claude joins a call and writes notes, a summary, decisions, action items and a transcript.
  - Recurring meetings share one project.
  - The summary is provisional while the call runs.
  - Lines from outside the organisation are marked.

### 1.2 "Research Claude Meetings, study the Debrief repo, audit both, tell me what to improve/add/remove"
**Keyword: Mango.**

A research agent read the official help article, the launch post, the release notes and press coverage. The main facts about Claude Meetings (beta from 12 Nov 2026):
- A visible bot. Google Meet and Google Calendar only.
- Team and Enterprise plans only.
- Audio is not kept.
- Shared screens are stored as text descriptions.
- In-call commands are answered in the chat.
- Live documents and whiteboards, and per-user connectors.
- A recap email.
- It leaves when an outside guest joins.
- No export.

The repo was read: about 15,000 lines across `src/`, plus the docs, the existing audit and the tests. The test suites passed after `npm install`.

Where Debrief was already ahead:
- No bot, so outside guests are no problem.
- Works for individuals.
- Works with any browser meeting app.
- Own keys or local models.
- Hinglish and Malayalam.
- The organisation template.
- Attendance.
- On-device voices.
- Gap detection.
- Export.

Weak spots found:
- **A:** each new transcript line rewrote the whole meeting record.
- **B:** times were spread proportionally across each piece.
- **C:** Deepgram diarisation was not used.
- **D:** no audio was kept.
- **E:** minutes existed only as Markdown.
- **F:** keyword-only Ask.
- **G:** no live view.
- **H:** no backup.
- **I:** a heavy repo.

A plan was proposed under the headings add, change, remove, and in what order.

### 1.3 "Make a branch called Fable daddy, make all these changes, run loops, check your work, use lower models at your discretion, don't ask until done"
- Git does not allow spaces in branch names, so the branch is `fable-daddy`.
- The main session acted as lead. It wrote one exact brief per piece of work, gave each agent its own files so no two agents edited the same file, reviewed each report, re-ran the tests, and then committed.

### 1.4 Pauses
- The run was interrupted several times by usage limits: a 5-hour limit, a weekly limit, and Fable credits running out.
- Each time, the stopped agents were resumed from where they had saved their work.
- When Fable reviewers were unavailable, reviews moved to Opus, then to Sonnet.

### 1.5 "Is this runnable now?"
Yes. The pushed branch builds and every automated test passes. It has not yet been tried on a real call with a real key.

### 1.6 "Audit this again and run loops to fix the issues"
**Keyword: Mango.**

Two more audit and fix rounds were run (sections 4.3 and 4.4).

### 1.7 "Stop everything, give me a prompt for my other session"
- The last fix agent was stopped.
- Its half-finished edits were stashed locally and not pushed.
- A handoff prompt was written (section 7).

---

## 2. How the work was organised

**Roles.**
- **Lead (main session):** planned, wrote the briefs, kept file ownership apart, reviewed every report, ran the tests, committed and pushed.
- **Builder agents:** Sonnet for most of the work; Opus for the storage rewrite and the deep reviews.
- **Reviewer agents:** a separate, fresh agent each round, never the one that wrote the code.

**Rules for every brief.**
- The exact files the agent may edit, and which files belong to other agents.
- No git commands. No `package.json` edits; the agent names the test file to add and the lead adds it.
- Every fix gets a regression test that fails on the old code and passes on the new code.
- The full `npm test` chain must pass, plus the relevant real-Chrome suites.
- UI work: capture screenshots, look at them, fix what is wrong, capture again.
- Report honestly what was verified and what was not.

**Commits.** Work was committed only when a whole package passed its tests. Half-finished work in progress was never pushed. This is why the stop hook was sometimes answered with "not yet".

**Loops.**
- **Build:** brief → agent builds and tests → lead re-runs the tests → commit.
- **Code review:** independent auditors (data and jobs; security and privacy; capture and pages) → findings with a severity, a proof script and a smallest fix → fix agents → tests → commit → a fresh audit.
- **UI review:** capture every surface in light and dark at narrow and wide widths → independent reviewers judge the screenshots against the project's own checklist and answer APPROVE or REJECT → fix agents → re-capture → new reviewers.

**Verification tools.**
- `npm test` runs about 50 node test files.
- 10 real-Chrome suites run headless Chromium through a wrapper script with `--no-sandbox`.
- `scripts/screenshots.mjs` captures every surface.
- The project's `ui-polish-review` skill provides the review checklist.

---

## 3. What was built (all on `fable-daddy`, version 1.4.0)

| Area | What | Main files |
|---|---|---|
| Housekeeping | Built files out of git; old design exports removed; 1.4 setting defaults | `.gitignore`, `src/store.js` |
| Naming | The "amnex" format renamed to "organisation template"; schema 3 migration; second Gemini key folded into the backup list. The "Use Amnex preset" button is kept | `src/orgtemplate.js`, `src/store.js` |
| Ask | Reads a whole meeting; matches across scripts; searches structured items; optional query expansion | `src/ask.js`, `src/askui.js` |
| Evaluation | Golden-set harness (word and character error rates, item P/R/F1, owner accuracy); `npm run eval` | `test/eval/*`, `docs/EVAL.md` |
| Storage | Meeting META plus lists stored in chunks, under Web Locks; backup and restore logic | `src/meetingstore.js`, `src/backup.js` |
| Minutes | Structured engine (one JSON call, classic fallback); action ids and status; carry-over logic | `src/structured.js`, `src/actions.js`, `src/minutes.js` |
| Timestamps | Real utterance times from Deepgram (`utterances`, `diarize`) and Whisper (`verbose_json`); "short pieces" option | `src/stt.js`, `src/utter.js` |
| Meet page | Chat notice helpers; record-reminder rules | `src/adapters/chat.js`, `src/nudge.js` |
| Models | Check model names against the provider; speaker model on demand (lite package, 4.2 MB against 28.9 MB) | `src/models.js`, `src/voice/modelstore.js` |
| Jobs | Carry open actions into the next meeting of a series; outside-organisation guard; webhook | `src/jobs.js`, `src/guard.js`, `src/webhook.js` |
| Capture | Kept recording in 30 s segments; shared-screen notes from a vision model | `src/audiokeep.js`, `src/screen.js`, `src/vision.js` |
| Wiring | Notice, reminder, presenting state, screen-note storage, live feed | `src/background.js`, `src/pill.js` |
| Live page | Transcript as it arrives, provisional summary, Ask | `extension/live.html`, `src/live.js` |
| Settings | Controls for every new feature, backup and restore, model check | `extension/options.html`, `src/options.js` |
| Minutes page | Play a line, read a stretch again, tick actions, screen notes, sharing confirmation, JSON download; Open actions page | `src/mom.js`, `src/momextras.js`, `extension/actions.html` |
| Docs | Changelog 1.4.0, privacy policy, README, audit section 9 | `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `docs/AUDIT.md` |

**Storage numbers, from a byte-counting test.**

| Write | Before | After |
|---|---|---|
| Adding one transcript line, late in a long meeting | about 287 KB | about 1.4 KB |
| A 5-second job heartbeat on a two-hour meeting | 5.3 MB | 2.3 KB |

---

## 4. Review rounds and what they found

### 4.1 Code review, round 1 (three reviewers)
**Storage and jobs.**
- A stale page copy could wipe the minutes and the emailed mark, so a second email was possible.
- Deleting a meeting during writing still emailed it.
- Cut-off answers were accepted silently.
- Action ticks were lost on a rewrite.
- Owners spoken in Devanagari were dropped.

**Security.**
- A restored backup could redirect the user's keys and transcripts to another server.
- The webhook was posted without Chrome's permission.
- Content scripts could control other tabs.
- The webhook payload carried transcript quotes.
- A participant could suppress the chat notice.

**Capture.**
- Transcript cleaning deleted real speech such as "Let's check the numbers".
- A failed start leaked the tab capture.
- Re-reading across a pause shifted times.
- Screen notes could use up the minutes quota.

All of these were fixed, each with a regression test.

### 4.2 UI review, rounds 1 to 3
- Round 1 rejected many things: two segments looked selected at once; tables scrolled sideways on phones; nested scrollbars; an invisible disabled button; the people table lost its labels at narrow width; and more.
- Round 2 found fewer: the usage table overflowed; two status orbs and two primary buttons while writing; the template overflowed on phones.
- Round 3 found two capture problems in the screenshot script: the popup scrollbar and the hidden tour bar. Both were fixed.

### 4.3 Code review, round 2 (after "audit this again")
**Data.**
- Claude stream errors were swallowed, so half-written minutes looked finished.
- The meeting list was not locked, so a new recording could vanish.
- Action ticks were not locked.
- A crafted backup could set share recipients.
- A double email was possible after a timeout.
- "Incomplete" was read as done.

**Security.**
- An unescaped template header could redirect the page, or run script in the downloaded A4 file.
- Slack and Teams markup passed through the digest.
- Retention settings and keys came from a backup without a tick.
- A participant named `__proto__` broke the presence map.
- `meet-mute` was not limited to the recorded tab.

**Pages.**
- Hand edits were overwritten while minutes were being written.
- Rewrites skipped the "edited by hand" confirmation.
- Exports were enabled with no minutes.
- Due dates were mangled ("6 marketing tasks" became "6 Mar").
- The player bar broke at narrow width.
- Several accessibility gaps.

All of these were fixed in commit `70e5e09`, with 764 checks and all Chrome suites passing.

### 4.4 Round 3 (final)
- **Code audit:** nothing above medium. It confirmed the round-2 fixes are correct.
- **UI reviews:** **APPROVE** on both the page screenshots and the README/Settings screenshots. Only cosmetic notes remained.
- **Remaining findings:** one medium and six low code findings, plus seven cosmetic UI notes. Their fix pass was interrupted (section 6).

---

## 5. State at hand-off

| What | Result |
|---|---|
| Pushed commit | `69916c2` on `fable-daddy` |
| `npm test` | All suites pass (764 checks) |
| Real Chrome | job, minutes, meet, settings, live, panel, smoke, gaps, voices and glass all pass |
| UI reviews | APPROVE on all screenshot sets |
| Not verified | A live Google Meet call with a real API key |

The Meet selectors used by the chat notice and presenting detection are best guesses. The list of checks a person must make is in `docs/AUDIT.md` section 9.

---

## 6. Not finished

The last fix pass was stopped by request. Its edits were stashed in this session only, so they are lost when the session ends.

**Code.**
- **D1 (medium):** a full disk can hang Stop, because the IndexedDB `abort` event is not handled in `src/audiostore.js`.
- **D2:** a manual share after an uncertain failure gives no "may already have been sent" warning.
- **D3:** a failed automatic share is not reported.
- **D4:** the offscreen document can be closed while a recording is starting.
- **D5:** a restored meeting can be auto-emailed on Rewrite.
- **D6:** any HTML reply from the relay is treated as "sign-in needed".
- **D7:** "Completed (was pending)" is read as open.

**UI (cosmetic).**
- **E1:** the Ask send button shifts on focus, and the placeholder is clipped at 360 px.
- **E2:** text shows through the Live page's sticky header.
- **E3:** the disabled danger button is too pale.
- **E4:** the Usage label wraps and leaves empty card space.
- **E5:** the writing state has too much blank space.
- **E7:** template cells wrap on phones.

---

## 7. Hand-off prompt for the other session

````
Repository: devshrawin/Debrief (GitHub). Work on branch `fable-daddy`.

First: check out fable-daddy, `npm install && npm run build` (built files are not in git), `npm test`, then `npm run share` → release/<date>/Debrief-v1.4.0.zip. Send me that zip. (`npm run pack-lite` = 4 MB store package without the speaker model.)

Context: version 1.4.0 adds a live transcript page, structured minutes with classic fallback, action tracking and carry-over, real per-line times (Deepgram/Whisper), optional kept recording, screen notes, Meet chat notice, record reminder, sharing guard, webhook, backup/restore, JSON export, model-name check, and a storage rewrite (META + chunked lists under Web Locks). Three code-audit and four UI-review rounds are done; the final UI reviews were APPROVE. See CHANGELOG.md, docs/AUDIT.md section 9, docs/EVAL.md.

Then fix D1–D7 and E1–E7 (listed in DEBRIEF-SESSION-NOTES.md section 6, or as described below), each with a regression test in a new test/pro-fixes-g.mjs added to the `npm test` chain:
- D1 src/audiostore.js run(): add tx.onabort reject; cap the offscreen teardown wait on the pool.
- D2 manual Share with e.unsure: warn "may already have been sent".
- D3 automatic share failure: record shareStatus and say so in the notification.
- D4 background offscreen-idle/closeOffscreen: never close while a recorder exists or is starting.
- D5 imported meetings: emailSkip, so no automatic email/share on Rewrite.
- D6 mailer: only Google sign-in pages mean sign-in; other 2xx HTML → unsure.
- D7 actions.js normStatus: decide by the leading word first.
- E1–E7 cosmetic UI items (Ask button shift/placeholder, Live header opacity, pale disabled danger button, Usage label/card height, writing-state spacing, template cells at 360 px).

Verify: `npm test`; real-Chrome suites with CHROME pointing at a wrapper that runs Chromium with --no-sandbox --disable-gpu --disable-dev-shm-usage (chrome-job, -minutes, -meet, -settings, -live, -panel, -smoke [re-run once if the tour check flakes], -gaps, -voices, -glass); `node .claude/skills/ui-polish-review/capture.mjs` for screenshots.

Still needs a person: a real Meet call with a real key (docs/AUDIT.md section 9).
Commit and push to fable-daddy; no pull request unless I ask.
````

---

## 8. Commit history of `fable-daddy`

```
69916c2 Regenerate screenshots after audit round 2 fixes
70e5e09 Audit round 2 fixes (streams, locks, email-once, restore, escaping, chat digests, edits, exports, due dates, a11y)
103d0de / 4589412 Screenshot regeneration and capture fixes
9505dcd UI review round 2 fixes
f5b4a4d UI review round 1 fixes
929c94f / 0c0fa19 README and audit notes for 1.4.0
1479aa1 Review fixes, security
67c7b3d Review fixes, storage and minutes
ccbf153 Review fixes, capture pipeline
7564454 Regenerated screenshots
6c6a265 Minutes page UI and Open actions page
8065bdc Settings for 1.4
ec31392 Version 1.4.0: changelog and privacy policy
bd1b81f Live transcript page
72cbb63 Wiring: notice, reminder, presenting, screen notes, live feed
eafece7 Kept recording and shared-screen notes
f30917c Carry-over, sharing guard, webhook
179bd44 Storage split, backup logic, structured minutes engine
09c8c8a Model-list check, lite package
bf73267 Meet chat notice helpers and reminder rules
(timestamps commit) Real per-utterance times
fd0777e Neutral template naming, Ask improvements, evaluation harness
cccfd8d Housekeeping
```
