---
name: ui-polish-review
description: Independent polish review of the Debrief Pro extension UI by a stronger model, ending in an explicit APPROVE or REJECT. Use whenever UI work on the popup, floating panel, Settings pages, tour, minutes, ask page or Meet pill is about to be called done, whenever the user complains the UI looks unpolished, clipped, overlapping, inconsistent or "fucked", and before pushing any change to extension/*.html, extension/style.css, fx/, src/pill.js or src/popup.js. Do not declare UI work finished without running it.
---

# UI polish review

Whoever builds a screen is the worst judge of it: they know what it was meant to look like. This skill puts a second, stronger model in front of the real screenshots with no knowledge of what was changed, and makes it answer APPROVE or REJECT. UI work is not done until the verdict is APPROVE.

## The loop

1. **Capture** every surface from real Chrome (never from reading CSS):
   `node .claude/skills/ui-polish-review/capture.mjs` writes PNGs to `docs/img/` and a list to `review-shots.txt`
   (it runs `scripts/screenshots.mjs`, the same fictional-data fixtures the README uses).
   Add a shot for any surface you changed that is not covered (a new page, a state such as error, empty, recording, dark theme).
2. **Review** with a stronger model than the one that did the work. Spawn one Agent, `model: "fable"` (fall back to `opus` if unavailable), with:
   - the paths of the screenshots to inspect (it reads them with Read, which shows images),
   - the full text of `references/checklist.md`,
   - the output contract below,
   - nothing about what was changed or what you believe is fine. An anchored reviewer approves what it is told is good.
   For large surface sets, split by surface group across several reviewer agents in one turn.
3. **Fix** every defect marked `blocker` or `major`; fix `minor` ones that are cheap. Fix the cause (a shared rule in `extension/style.css`) rather than the one screen it showed on, because the same defect is usually on three screens.
4. **Re-capture and re-review.** A new reviewer agent each round (a reviewer that remembers the last round starts defending its own list). Stop at APPROVE, or after 3 rounds report the remaining defects to the user plainly instead of approving.
5. **Report** the final verdict, the rounds it took, and anything the screenshots cannot show (real Meet call, toolbar click, hover and animation states).

## Output contract for the reviewer

Ask for exactly this, so the verdict can be acted on and is not a vibe:

```
VERDICT: APPROVE | REJECT
DEFECTS:
- [blocker|major|minor] <surface> — <what is wrong, where in the image> — <likely cause / fix>
NOT VERIFIABLE FROM SCREENSHOTS: <list>
```

Rules for the reviewer: REJECT if any blocker or major remains. Be specific (name the element and its position). Do not praise. Do not invent defects to look thorough; if a surface is clean, say "no defects" for it. A screenshot that is blank, cropped by the capture tool, or shows a loading state is a capture problem, not an approval: say so and ask for a re-capture.

## Gotchas learned on this project

- The capture viewport is fixed per shot; "cut off at the bottom" in a screenshot may be the crop, check the shot's height before calling it a defect.
- Chrome's toolbar popup is an opaque window: do not ask for see-through glass there. The floating panel (`src/panel.js`) is where the page shows through.
- Background animation cannot be judged from a still; it is covered by `node test/chrome-glass.mjs`.
- Run `npm test`, `node test/chrome-glass.mjs` and `node test/chrome-panel.mjs` before the review so the reviewer's time goes on looks, not on regressions.
