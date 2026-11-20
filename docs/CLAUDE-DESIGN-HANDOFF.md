# Debrief: end-to-end redesign brief (for Claude Design)

## What this is
Debrief is a Chrome (Manifest V3) extension. It records a Google Meet tab, turns speech into text with the provider the person picks, and writes meeting minutes. Audio and text go from the browser to that provider. Nothing is stored on any server of ours. Voice fingerprints and optional short clips stay on the device.

Name stays **Debrief**. Do not rename anything.

## What is wanted
Redesign every surface end to end as one coherent system. Deliver designs the code can adopt directly: HTML and CSS mapped to the files below, plus a short token and component spec. A design that cannot be built in plain HTML, CSS and vanilla JS is not useful here.

## Surfaces (every one is in scope)
| Surface | Source | Screenshot (docs/img) |
|---|---|---|
| Toolbar popup (idle, recording, finished) | extension/popup.html, src/popup.js | popup.png, popup-dark.png, popup-recording.png |
| In-call pill and reminder card on the Meet page | src/pill.js (Shadow DOM, CSS inside the file) | pill.png, countdown.png |
| Minutes page (standard and organisation template; countdown card, writing state, "Who was speaking?", attendance table, actions, Ask box, share box, player) | extension/mom.html, src/mom.js, src/orgtemplate.js | minutes-standard.png, minutes-official.png, minutes-dark.png, organisation-template.png, writing.png, voices.png, minutes-actions.png |
| Live page (transcript while recording, provisional summary, Ask) | extension/live.html, src/live.js | live.png |
| Actions page | extension/actions.html | actions.png |
| Ask page (ask across all meetings) | extension/ask.html, src/askpage.js, src/askui.js | ask.png |
| Settings (Get started, General, Speech to text, Minutes, Email, Voices, Usage, Backup) | extension/options.html | settings-start.png, appearance.png, usage.png |
| First-run tour | extension/welcome.html | tour-key.png, tour-ready.png |
| Notifications, printed, Word and email minutes | src/jobs.js, src/orgtemplate.js, extension/print.css | minutes-official.png |
| Store listing images | scripts/screenshots.mjs | store-1 ... store-4, store-promo-* |

All shared styling lives in `extension/style.css` (tokens at the top). `docs/DESIGN-SYSTEM.md` describes the current system. It is documentation of what exists, not a constraint.

## Honest state of the current UI
- The look has been changed several times by different sessions. Pages share tokens but not rhythm: spacing, header bars, card weights and button emphasis differ page to page.
- The newest page (Live) was only just aligned to the Minutes page. Treat the Minutes page as the closest thing to a reference, and challenge it.
- The logo on this branch is deliberately black and white (it marks the work-in-progress build). Design the final mark too if you want to.
- Known rough edges: Settings is one very long page (92 KB of HTML); the Usage table is dense; the "Who was speaking?" card is functional but plain; the popup has many states in a small space; the tour is two steps but visually separate from the rest.

## Hard constraints (the build breaks without these)
- Plain HTML, CSS, vanilla JS bundled by esbuild. No React in pages. No remote fonts, scripts, images or analytics (MV3 CSP, and the privacy promise).
- Popup works at 360 to 400 px wide. Minutes, Live, Ask, Settings work from 360 to 1440 px, and at 200 percent zoom.
- Light and dark, automatic. Text contrast at least 4.5:1 on every surface. The minutes document is an opaque reading surface. Printed, Word and email output stay plain and print-safe.
- Honour `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast: more`. Visible `:focus-visible`. Every icon button has a label. Job status uses `aria-live`.
- The pill is injected into Google Meet inside a Shadow DOM, so it must not depend on page CSS.
- No behaviour regressions: background minutes job, live progress, countdown and hold, resume after restart, one email only, voice naming with Play and Remove, attendance "Name (address)", quota warning with its close button, the two-step tour, the cross on the pill that hides it for one recording.
- Keep the organisation template generic by default, with the "Use Amnex preset" button working.

## Please deliver
1. A short design brief for approval: principles, token set (colour, type, spacing, radius, shadow, motion), component list, and a screen-by-screen plan. Say what you would cut or merge (for example, splitting Settings into sections or pages).
2. Static HTML and CSS for each surface in the table, at phone and desktop width, light and dark, mapped to the file names above.
3. A component sheet: buttons (primary, plain, danger, disabled), inputs, switch, segmented control, badge, card, banner, modal, toast, table, empty state, loading state.
4. Notes on anything that needs a code change beyond CSS (new markup, new state).

## How to look at the real thing
`npm install`, `npm run build`, then load `extension/` unpacked in Chrome. `node scripts/screenshots.mjs` regenerates every image in docs/img from the real pages. `npm test` runs the suites. The zip you were given is source and screenshots only. It leaves out speech models and vendor libraries (about 40 MB), so it cannot be loaded as-is. Build from the full repo (devshrawin/Debrief, branch `fable-daddy`).
