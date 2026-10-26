# Changelog

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
