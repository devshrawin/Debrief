# Debrief design system: solid and quiet

One look across the popup, the on-page panel, Settings, the minutes page, the tour and Ask. Tokens live in the "Solid system (redesign)" block at the end of `extension/style.css`; it loads last and replaces the earlier glass values, so pages written before it keep working through their older short names (`--card`, `--line`, `--muted`, `--brand`...).

## Rules
- **Opaque surfaces only.** No blur, no gradients behind text, no moving background. Cards sit on a flat page colour with a hairline border.
- **One accent colour** (`--tint`) for the main action and links; red only for Stop and errors; amber for warnings; green for done.
- **Contrast.** Every text pair is at least 4.5:1 in light, dark and forced-dark. `test/pro-contrast.mjs` reads the tokens and fails when one is changed below that.
- **Type.** System font stack; nothing under 12 px; helper text uses `--label-3`.
- **Targets.** Buttons and rows are at least 36 px tall (44 px for the main actions); focus rings are never removed.
- **Motion.** Short fades only; respect `prefers-reduced-motion`.
- **Print** drops everything but the minutes. Word and email output are unaffected.

## Pages
- **Popup (360 px, under Chrome's 600 px limit).** Header with Ask and Settings; one card saying what will be recorded (title, site, online / in-room); one Start button; the three latest meetings; a "More" menu for check page detection, the tour and shortcuts. While recording: status and timer, two level meters, Pause and Stop side by side.
- **Minutes page.** Left: Rewrite minutes, Edit minutes, status. Right: Export and Email menus. A Layout row holds the format and meeting-type choosers; changing them never rewrites the minutes by itself.
- **Settings, tour, Ask.** Same cards and tokens; no structure of their own.

## Theme
`extension/fx/theme.js` (source `fx/src/pages/theme.js`) sets light or dark from Settings > Appearance before the page paints, and marks the page when it runs inside the on-page panel (`html.in-panel`).
