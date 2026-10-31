# Changelog

## 1.2.0 — 2026-10-31 (side panel)
- Debrief now opens in Chrome's side panel from the toolbar button, on every page (also chrome:// and the new-tab page). It stays open while you click the page, switch tabs or record. The floating glass panel and Chrome's square popup are gone.
- New solid look: opaque surfaces, one accent, light and dark, no blur or animated background; text pairs checked at 4.5:1. The effects layer (orbs, beams, goo, metal) and the Reduce transparency and Glass and motion settings are removed.
- Panel layout: header that says what Debrief is doing, Home / Meetings / Ask tabs, cards, and a sticky foot (Start, or Pause + Stop and write minutes). Recording shows a live transcript of the last three lines; finishing shows its steps; Ask answers inside the panel.
- Tests: test/chrome-sidepanel.mjs renders every state at 320, 420 and 600 px in both themes.

## 1.1.3 — 2026-10-30
- Settings: the speech and general Gemini model fields are dropdowns (with "Other…" to type a name).
- Settings → Appearance: "While recording" card with the recording pill (moved from Recording) and a new "Hide the recording icon on the toolbar" switch.
- Quota warnings: a per-minute 429 was saved as a daily limit and warned every morning; limits are now learned only from per-day errors (old learned limits are cleared once). The warning says when the count starts again (midnight Pacific, about 12:30 pm IST), and Settings → Usage has a switch to turn the warnings off.
- Speech to text: a stretch of a meeting could silently come back with almost no text (or none). A piece answered with far too little for the speech in it is now read again in short parts; if it is still thin it is reported. The minutes page shows "No transcript for 20:47–24:21" in the transcript and in the warning box, and the minutes carry a coverage warning that names it. Quiet stretches and pauses are not reported.
- Speech to text: notes a model writes about the audio ("Silent audio track…", "Analyse the audio: - 00:00 - 00:46 …", "Keywords to check…"), made-up speaker labels (Speaker 1, Female voice), romanised glosses after Malayalam, video offsets inside the words and a passage written twice (also across neighbouring pieces, also when the fillers differ) are removed from transcripts, in the transcript view and in what the minutes writer reads. Meetings already recorded are cleaned when opened.
- English written in Malayalam or Hindi letters by the transcription model is detected in meetings that mix English in; the piece is read once by a general model and its answer is used when it has the English words in English letters.
- Notifications from the background (quota or microphone alerts, "stopped recording", "minutes emailed") never appeared: the icon path was relative and resolved next to the service worker, so Chrome reported "Unable to download all specified images" (Errors page: extensions::notifications). The icon now has a full address.
- Tests: the recorder is run in Node with a fake browser and fake speech-to-text; real Chrome checks the gap display and that notifications are created.

## 1.1.2 — 2026-10-28
- Minutes page: naming the last unnamed voice with a name that already has a voice (a second device or headset of the same person) used to be refused, leaving it unnamed for ever. It now asks "Is this the same person?" and joins the two.
- People and their details (title, department, designation, organisation, email, chair) now live in Settings → Voices: a table next to the voices, details fields when naming or adding a voice, a details line and Add details on each voice. They feed the attendee tables of the minutes.
- Speech to text: the fallback model's thinking, repeated passages and made-up speaker labels are cleaned out of transcripts (also of meetings already recorded); Meet's button text no longer reaches the spelling hints; the fallback prompt keeps English in English letters.


## 1.1.1 — 2026-10-27
- Pill: the mic button shows "Mic off" while you are muted in the call and "Mic on" when you unmute (it had been stuck on "Mic on"); the "Debrief is recording" line is no longer drawn on top of the pill (it is spoken to screen readers only).
- Meet mute button is read more tolerantly if Meet rewords its labels.
- Test: a fake Meet page checks the mute following end to end.

## 1.1.0 — 2026-10-26
- Email settings: who else gets a copy is a table in the same step as the script setup, with the allow-list and the "copy script" button right under it (also in the tour).
- Any number of Gemini backup keys: a + button adds more, tried in order.
- People directory is a table you can add to, with paste from a spreadsheet.
- Voices: the merge dialog is laid out properly, a taken name offers to merge, unnamed voices have a Play clip; voice learning no longer fails on stored typed arrays and says which step failed if it does.
- Official minutes follow the house template more closely: footer and margins, organisation-level responsibility, "Not Applicable" for information-only topics.
- Minutes: Overview, Decisions, Risks and Blockers and Next Checkpoints; owners filled in; missed points merged into the right section.
- Pill: can be clicked and dragged again and no longer shows "muted in the call".
- Check my setup: the warning icon is a proper circle. Many small polish fixes across Settings, the tour, the popup and the minutes.

## 1.0.0 — 2026-10-26
- First public release. Glass design on every screen, in light and dark, with calm motion you can turn off (Settings → Appearance).
- Floating panel over the page; discard a recording started by mistake; a first-recording reminder to tell participants.
- Minutes: Overview, Decisions, Risks and Blockers, Next Checkpoints; every action has an owner; missed points are merged into the right section; attendance uses when people were actually in the call.
- Unnamed voices get a Play clip; the on-page pill can be dragged again and no longer shows "muted in the call".
- Polish pass on every screen (tour, Settings, popup, minutes); no links to the author's GitHub inside the extension.
- Store pre-flight check built into packaging.

## 0.2.4 — 2026-10-26
- The floating panel no longer shows a square scrollbar strip at its rounded edge, and grows to fit its content.
- "Close to a daily limit" can be closed (it comes back tomorrow).

## 0.2.3 — 2026-10-26
- No links to the author's GitHub inside the extension (setup guides removed from Settings and the tour). Only the store's privacy policy link remains. Store pre-flight now checks this.

## 0.2.2 — 2026-10-26
- Fix: the on-page pill could not be clicked or dragged (the glass restyle let clicks pass through it). It moves again, and a test now checks that a real click reaches it.
- Fix: "Name this voice" in Settings → Voices now has a Play button; a short clip is kept for each voice nobody has named yet. (Meetings recorded before this update have no clip: their audio was already deleted.)
- Settings pages leave room for the Save bar at the bottom.

## 0.2.1 — 2026-10-24
- Store readiness: panel page uses a dynamic URL, first recording asks you to confirm you will tell the others, shorter manifest description (store limit 132), store pre-flight check (`npm run store-check`) built into packing.
- Polish: usage table fits, search field, recording bar, tour progress.

## 0.2.0 — 2026-10-23
- New glass design on every screen, moving colour background, thinking orbs, border beam on search.
- Floating glass panel over the page instead of Chrome's popup (switch off in Settings → Appearance).
- Settings → Appearance: theme, reduce transparency, moving-background speed, animated effects.
- Discard a recording started by mistake (no transcript, no minutes).
- Minutes job runs in the background and resumes; structured minutes editor.
- Polish pass from an independent UI review (usage table, search field, recording bar, tour progress).

## 0.1.0
- First working build: Meet recorder, transcription, minutes, voices, email and sharing.
