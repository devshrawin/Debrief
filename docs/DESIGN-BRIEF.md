# Debrief: glass redesign, Phase 0 brief

Status: **for approval.** No code has been changed. Companion: `docs/LIBRARIES-INVENTORY.md`.

## 0. What I could and couldn't do this phase

| Item | Result |
|---|---|
| `npx modern-web-guidance@latest install --choose` | The CLI runs (v. latest, 191 guides), but `--choose` is an interactive picker, so I can't drive it from here. I used `search` / `retrieve` instead. **There is no `chrome-extensions` guide in its catalogue**, so `CHROMEWEBSTORE.md` will follow Chrome's own listing and permission-justification fields. |
| `claude mcp add chrome-devtools … --autoConnect` | Not possible. It has to attach to *your* Chrome through chrome://inspect, and this session isn't linked to your computer. **Substitute:** Playwright with Chromium in this sandbox, loading the unpacked extension. That gave screenshots of every page in light and dark, console errors and load timings. |
| Repo (`src/`, `test/`, `scripts/`, `README.md`, `docs/AUDIT.md`, `docs/img`) | **Not available.** I only have the built `Debrief-Pro-v0.1.0` zip from earlier. That means: no `src/jobstate.js`, no tests, no `npm run build`, no commits. The audit below covers v0.1.0, which may be older than branch `pro`: it has no countdown card or "Who was speaking?" box. |
| Libraries.dev | Fully read and measured (see the inventory). |

**To start Phase 1 I need** either a zip of the repo on branch `pro` with `.git` included, or this session linked to your computer with the repo folder connected.

## 1. Name

You asked to keep **Debrief** for now. Phase 1 therefore doesn't rename anything. Instead it moves every user-visible "Debrief" into one place (`src/brand.js` plus `__MSG_appName__` in the manifest), so a later rename is a one-line change. Candidates for later (store and trademark availability **not checked**):

| Name | Why |
|---|---|
| **Debrief** (keep) | Already says what it does; users know it |
| Sabha | सभा / സഭ means "assembly" in Hindi and Malayalam; fits the Indic focus |
| Kurippu | കുറിപ്പ് means "note" in Malayalam; distinctive but harder to say for non-Malayalis |
| Minutely | Literal and friendly; probably crowded |
| Recap | Short; very likely taken |

## 2. Audit of v0.1.0 (Playwright, 1280 px and 360 px, light and dark)

No console errors on any page or in the service worker. `load` ≤ 140 ms on every page; the first popup open was 308–450 ms (cold profile).

1. **Four colour systems.** `style.css` sets accent **Google blue `#1a73e8`**. The popup redefines its own indigo/saffron/rose/mint variables (38 distinct colours). Options and the tour use indigo. The Ask page falls back to Google blue, so its Ask button is blue while every other primary button is indigo.
2. **Seven-plus corner radii** (2, 4, 6, 7, 8, 9, 10, 11, 12, 14, 16, 999 px) with no scale.
3. **Background differs per page**: grey `#f6f7f9` on Settings and the tour, white on Ask and the popup.
4. **The popup's idle call to action fails contrast.** The disabled saffron gradient with dark text reads at roughly 2:1, and the label "Record this tab (not a known meeting site)" wraps onto two lines inside a hero card.
5. **Ghost buttons.** A faint blank pill sits at the bottom-left of the tour and Settings footers (the hidden Back button and save message still paint a background).
6. **The sticky save bar covers content.** In Settings it overlaps the "Check my setup" card, and there is no padding under the last card.
7. **Kicker colour.** The tour uses an orange uppercase kicker; Settings has none.
8. **Customer data in the product.** Ask suggestions and a placeholder ship real project text ("the Kerala mapping", "What did Amal say…", in `dist/askpage.js`). **I'll replace these with generic prompts in Phase 1.**
9. **The minutes page with no meeting** shows a bare "Meeting not found." with no way back.
10. **Inline styles.** 41 in `options.html` and 11 in `mom.html` hard-code spacing and colours.
11. **Spinners.** Nothing indicates job stage beyond text.

## 3. Design language: "Clear glass over a quiet room"

Principles: **clarity, deference, depth** (Apple HIG).
- Content sits on opaque reading surfaces. Glass only frames and organises it.
- One brand tint (indigo).
- Saffron means only "a call is on and you are not recording".
- Red means only recording or deleting.

### 3.1 Tokens (all in `extension/style.css`, light and dark)

**Type.** HIG names with sizes tuned for desktop and Indic scripts. Body line height stays ≥ 1.6. Stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable", system-ui, "Nirmala UI", "Kartika", sans-serif`. The last two cover Devanagari and Malayalam on Windows.

| Token | Size / line | Weight | Token | Size / line | Weight |
|---|---|---|---|---|---|
| `--t-large-title` | 30/38 | 700 | `--t-body` | 15/24 | 400 |
| `--t-title-1` | 24/32 | 700 | `--t-callout` | 14/22 | 400 |
| `--t-title-2` | 20/28 | 600 | `--t-subheadline` | 13/20 | 400 |
| `--t-title-3` | 17/24 | 600 | `--t-footnote` | 12/18 | 400 |
| `--t-headline` | 15/22 | 600 | `--t-caption` | 11/16 | 500 |

Times and counts use `font-variant-numeric: tabular-nums`. Labels are sentence case; there are no uppercase section labels.

**Colour.** Semantic tokens, Apple-style. Values were chosen by **measured contrast over glass** (§3.2), not copied from Apple's palette. Apple's own `secondaryLabel` (60% alpha) measured **2.8–3.3:1** over light glass, so it fails.

| Token | Light | Dark |
|---|---|---|
| `--label` | `#1d1d1f` | `#f5f5f7` |
| `--label-2` (secondary) | `#55555c` (opaque) | `#a3a3ad` |
| `--label-3` (disabled only; 3.4:1, which is allowed for disabled controls. Placeholders use `--label-2`) | `#8a8a92` | `#6e6e78` |
| `--separator` | `rgb(60 60 67 / .18)` | `rgb(84 84 88 / .55)` |
| `--fill` / `--fill-2` | `rgb(120 120 128 / .12)` / `.08` | `rgb(120 120 128 / .32)` / `.24` |
| `--tint` (brand indigo) | `#3634a3` | `#a9a6ff` |
| `--tint-fill` | `#3634a3` with white text (9.6:1) | `#8e8cff` with `#14123a` text (6.2:1) |
| `--red` (record, destructive) | text `#b0000e`, fill `#d70015` with white text (5.4:1) | `#ff7a72`, fill `#ff6961` with `#2a0705` text |
| `--orange` (call on, warning) | text `#a8370a`, fill `#ff9f0a` with `#1d1d1f` text (8.2:1) | `#ffb340` |
| `--green` (works, saved) | text `#146c2e`: 5.3:1 on regular glass, 5.8:1 on its tinted chip | `#30db5b` |

**Spacing.** 8-pt grid: 4, 8, 12, 16, 24, 32, 48. Hit targets are at least **44 px** (the brief's 36 px floor is raised to the HIG's 44).

**Radii.** Continuous-feel tiers: `--r-xs 6` (chips), `--r-sm 10` (controls), `--r-md 14` (cards), `--r-lg 20` (sheets and the popup), `--r-pill 999`.

**Motion.**
- `--spring` is a CSS `linear()` curve generated by liquid-gooey's `spring.ts` from its `snappy` preset (stiffness 480, damping 34); `smooth` for sheets.
- Durations: `--d-fast 200ms`, `--d-base 280ms`, `--d-slow 350ms`.
- Nothing blocks input during motion.

### 3.2 Materials (glass)

| Tier | Used for | Light | Dark | Blur / saturate |
|---|---|---|---|---|
| `--mat-ultrathin` | Ambient overlay, switch tracks, the pill on dark video | `rgb(255 255 255 / .40)` | `rgb(28 28 30 / .40)` | 12 px / 160% |
| `--mat-thin` | Sidebar, toolbars, segmented tracks | `/ .58` | `/ .58` | 20 px / 170% |
| `--mat-regular` | Cards, the popup body, menus | `/ .72` | `/ .72` | 28 px / 180% |
| `--mat-thick` | Sheets, dialogs, toasts | `/ .86` | `/ .86` | 36 px / 180% |

- Every tier gets `box-shadow: inset 0 1px 0 rgb(255 255 255 / .5)` (dark: `.08`) for the highlight edge, plus two soft drop shadows that grow with depth.
- **Depth order:** background < content (regular) < toolbar (thin, sticky) < popover (regular + shadow) < modal (thick + `::backdrop` dim).
- **Ambient background:** three blurred radial-gradient shapes (indigo, saffron, sky) on `body`. They are static, with an optional 90 s drift that is off under reduced motion.

**Measured contrast, worst case** (text over the tier composited on the most saturated ambient colour, before blur):

| | ultra-thin | thin | regular | thick |
|---|---|---|---|---|
| `--label`, light | 10.6 | 12.2 | 13.7 | 15.2 |
| `--label-2` `#55555c`, light | — | 5.4 | 6.0 | — |
| `--tint` `#3634a3`, light | 6.1 | 7.0 | 7.8 | 8.7 |
| `--label`, dark | 11.2 | 12.6 | 13.7 | 14.7 |
| `--label-2` `#a3a3ad`, dark | — | 5.5 | — | — |

**Rules that follow from these numbers:**
- Body and secondary text sit only on **thin or heavier**.
- Coloured text (red, green or orange) sits only on **regular or heavier**, or on its own tinted chip.
- Ultra-thin carries no text except the pill's white timer on its dark scrim.

**The minutes document is opaque** (`--surface-read: #fff` / `#1c1c1e`). Glass frames it and never sits behind body text. Print, Word and email use the existing official A4 layout from the canvas, with no glass and no tokens beyond the navy.

**Fallbacks:**
- `@media (prefers-reduced-transparency: reduce)`, `(prefers-contrast: more)` and `(forced-colors: active)` replace every material with a solid tinted surface and calm every effect: beams static, orbs on a static frame, metal paused.
- `@supports not (backdrop-filter: blur(1px))` falls back the same way.
- I'll also add a **"Reduce transparency" switch in General**, because browser support for `prefers-reduced-transparency` should be checked before relying on it.

**Performance rules:**
- At most **2 stacked `backdrop-filter`s** in any view.
- No blur on scrolling lists, table rows or transcript lines; rows are opaque or `--fill`.
- I'll trace popup open time and minutes-page scrolling (Performance panel); any surface that drops frames falls back to solid.
- Budget: popup open ≤ 120 ms to first paint on a warm profile.

## 4. Components (built once, used everywhere)

- **Buttons:** prominent (tint fill), tinted (tint 12% fill), plain (text only), destructive (red), each with pressed, disabled, focus and loading states. Loading shows an orb at 20 px, never a spinner.
- **Switch:** iOS proportions, 51×31 scaled to 44×26. Native `<input type=checkbox role=switch>`.
- **Segmented control:** native radio group, with a goo-trailing thumb.
- **Pull-down menu and popover:** `popover` attribute plus anchor positioning, opening with a spring from its button.
- **Sheet dialog:** `<dialog>` with focus trap, Escape to close and `closedby="any"`; it becomes a bottom sheet under 480 px.
- **Field row, secret field, list row, toolbar, sidebar.**
- **Toast:** `aria-live=polite`.
- **Inline progress:** orb plus status text.
- **Chips:** status chips and a removable multi-select.
- **Avatar group:** goo-merged silhouettes.
- **Callout:** info, warning or error, each with one action.
- **Empty state:** one line of text plus one action.
- **Large title:** collapses into the toolbar title on scroll, using a scroll-driven animation.

Every icon-only button gets an `aria-label`. `:focus-visible` is a 3 px tint ring with a 2 px offset. Layout uses logical properties throughout, so it is RTL-safe.

## 5. Libraries.dev: where each piece goes, and how

**No page gets React.** Every piece below is either a React-free engine the library already exports or a small vanilla port. The measured numbers are min / raw sizes.

| Piece | Integration | Added size | Where it goes |
|---|---|---|---|
| **border-beam** | **Port, build time.** A build script runs `generateBeamCSS()` for the presets we use (palette `ocean`, retinted toward the indigo tint, light and dark) and writes them to `extension/beam.css`. The breathing loop (`pulseDriver.ts`) is vendored as `src/fx/beam.js`. | ~1.5 KB JS plus ~7–13 KB CSS per preset per theme. Popup: `pulse-inner` only (≈26 KB CSS). Minutes page: `md` + `line` (≈40 KB). Pill: `pulse-inner` dark only (≈13 KB, inside the shadow root) | **Popup** recording card: `pulse-inner`, calm. **Start button**, only while a call is detected: palette `sunset`, which ties to the saffron call glow; static when idle. **Minutes page** "Writing the minutes" card: `md`, while the job runs. **Ask box** on focus: `line`. **Key field** while "Test my key" runs: `line`. **Pill** while recording: `pulse-inner` at strength 0.6. |
| **thinking-orbs** | **Use `thinking-orbs/engine` as published** and wrap it in a `<db-orb state size>` custom element (~60 lines). It keeps the library's own behaviour: DPR cap, shared clock, offscreen and hidden-tab pause, a static frame under reduced motion, `role=img` with a label. | ≈15 KB per page that uses it | Replaces **every spinner and skeleton**. Proposed mapping, to confirm against `src/jobstate.js`: recording → `listening`; transcribing → `working`; recovering missing audio → `weaving`; transcribing failed audio → `solving`; reading the transcript → `searching`; writing the minutes → `composing`; completeness check → `shaping`; emailing or sharing → `connecting`; countdown or hold → `breathing`. On the Ask page: searching → `searching`, answering → `composing`. Status text sits next to it in an `aria-live` region. |
| **liquid-gooey** | **Partial port.** Vendor `spring.ts` as it is (1 KB), for the `--spring` easing and every transition. Hand-port Move as one SVG goo filter under a sliding thumb (~3–4 KB). Do **not** port `observer.ts` (103 KB of source). | ≈5 KB | **Segmented controls:** Online meeting / In a room, Organisation template / Standard, Home / Meetings, Minutes / Transcript. **Sliding tab and selection indicators.** **"More" and menu popovers** that bridge out of their button while opening, then go crisp. **Avatar groups** of attendees and voices: a static goo merge, no animation. |
| **metal-fx** | **Use the engine directly** (`createInstance` and friends) with a ~80-line vanilla wrapper. WebGL2, one shared context per page, 15 fps, paused when hidden. Without WebGL2, or under reduced motion or transparency, it shows a plain paused frame. | ≈31 KB, **loaded lazily** after first paint (`requestIdleCallback`) and only on pages that use it | **Wordmark:** `MetalText`, ported, in the tour hero and the About card only. **Record button ring** in the popup, only in the *call detected and idle* state. Lazy-loaded so the popup still paints first; if a trace shows it adds more than 30 ms, it is dropped in favour of the beam. **Badges:** one `MetalBadge`-style rim on "Emailed" / "New" in the **minutes page header**. Never in lists, the popup meeting list or the pill. |
| **img-fx** | **Skipped.** It needs three.js: 489 KB min with three tree-shaken, about 26× today's `popup.js`. Debrief has no images to reveal, so it would be pure decoration. | 0 | — |

All of this ships under `src/fx/`, bundled by esbuild into only the pages that import it. There is no remote code, no `eval`, and WebGL shader strings are compiled by WebGL (CSP-safe). `NOTICE.md` gains the MIT notices plus the Paper Shaders Apache-2.0 NOTICE word for word.

## 6. Screen by screen

| Surface | Plan |
|---|---|
| **Popup** (360–400 px) | Regular-glass body over the ambient background. Large title "Debrief" (metal wordmark only on the tour). Segmented Home / Meetings. **Idle:** one prominent "Start recording" button. **Call detected:** an orange banner plus the beam and metal ring on Start. **Recording:** red REC chip and tabular timer, pulse beam around the live card, two meters, the mic switch with its mute-state line, quota callout with its close button. **Finishing:** orb `working`, then `composing`. **Meetings tab:** an opaque list with search and swipe-free delete (button plus confirm sheet). |
| **Pill** (Meet) | Dark ultra-thin capsule on a scrim, so it reads over any video. REC dot, an orb at 20 px in `listening` instead of the equaliser, tabular timer, three-state mic. Clicking opens a thick-glass panel. Same constraints as before: closed shadow root, `pointer-events` only on its own box, edge snap, full-screen re-parenting. |
| **Minutes page** (360–1440 px) | Thin-glass toolbar with a collapsing large title (the meeting title, editable). Countdown and hold card: regular glass with a `breathing` orb and Hold / Write now buttons. "Writing the minutes" card: beam `md` plus orb, live stage text, `aria-live`. "Who was speaking?" box: avatar group plus ▶ Play per voice and a name field. Attendance table: opaque, "Name (address)" kept. Ask box: `line` beam on focus. Share box: popover. **The document is an opaque reading surface**; Print, Word and email keep the official format. |
| **Settings** | Sidebar (thin glass) and a content column, sticky toolbar with Save and a "Saved" toast. Fixes the overlap and ghost buttons. Seven pages, each restyled with the shared components. Segmented Organisation template / Standard, with **"Use Amnex preset" kept**. Voices: avatar list, ▶ Play sample, enrol sheet. Usage: opaque table, "~" estimates explained. |
| **Tour** | The same two-step flow and 12 pages. Hero with the metal wordmark and ambient background; the step rail in thin glass; key test with a `line` beam and `connecting` orb. |
| **Ask page** | Large title, scope segmented control, a big glass question box with the `line` beam on focus, a streamed answer on an opaque surface with numbered sources, the privacy note. Generic example prompts. |
| **Notifications** | Text only (Chrome renders them), unchanged apart from going through `brand.js`; new icon variants. |
| **Icons** | Same mark, retuned to the new indigo. Glow, REC and attention variants at 16, 32, 48 and 128. |

## 7. Phases (one commit each; build plus all four test commands after each)

1. **Brand constant and copy hygiene.** `brand.js`, `__MSG_appName__`, generic Ask prompts, `CHROMEWEBSTORE.md` draft. Storage keys, IndexedDB names, message types, `key` and schema stay untouched.
2. **Tokens and materials.** New `style.css`, ambient background, fallbacks, Reduce transparency setting. Pages migrate off per-page colours with no layout changes yet.
3. **Effects layer.** `src/fx/{orb,beam,goo,metal}.js`, build-time beam CSS, `NOTICE.md`, size report.
4. **Popup and pill.**
5. **Minutes page and Ask**, including the print, Word and email checks.
6. **Settings and tour.**
7. **Accessibility and performance pass:** axe, keyboard, 200% zoom, RTL smoke test, DevTools traces. Then screenshots, `README`, `docs/DESIGN-SYSTEM.md`, `docs/AUDIT.md`, final report.

## 8. Decisions I need from you

1. Approve keeping **Debrief** (Phase 1 then only centralises the name) or pick a candidate.
2. Approve **no React anywhere** (the vanilla ports in §5) and **skipping img-fx**.
3. Approve **raising hit targets to 44 px** and **opaque secondary text** (a deviation from Apple's translucent `secondaryLabel`, for AA).
4. Send the **repo on branch `pro`**, or link this session to your computer with the repo connected.
