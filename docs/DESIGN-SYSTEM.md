# Debrief design system: solid, calm, side panel first

Debrief lives in Chrome's side panel (`popup.html?side=1`, opened by the toolbar button on every page). Every extension page loads one stylesheet, `extension/style.css`; the "Solid system" block at its end is the source of truth (opaque surfaces, one soft shadow, no blur, no colour room). The glass materials above it are legacy names that now resolve to solid surfaces. `fx/theme.js` only applies the light / dark choice.

Layout of the panel: fixed header (logo, what Debrief is doing, Settings) → tabs (Home, Meetings, Ask) → scrolling body of cards → sticky foot with the one action that matters (Start / Pause + Stop). Works from 320 to 600 px wide; below 360 the Pause and Stop buttons stack. `test/chrome-sidepanel.mjs` renders every state at 320 / 420 / 600, light and dark; `test/pro-contrast.mjs` checks every text pair at 4.5:1. Screenshots: `docs/img/side-*.png`.

Older text follows (kept for the tokens that still exist):

Principles (Apple HIG): **clarity, deference, depth.**
- Content sits on opaque reading surfaces. Glass only frames it.
- One brand tint: indigo.
- Saffron (`--orange`) means only "a call is on and you are not recording", or a gentle warning.
- Red means only recording or deleting.
- Green means only "works, allowed, saved".

## Tokens

### Type
HIG names, with sizes tuned for desktop and for Devanagari and Malayalam (body line height 1.6).

| Token | Use | Size / line |
|---|---|---|
| `--t-large-title` | Page title (collapses on scroll on the minutes page) | 30/38, 700 |
| `--t-title-1` | Document title | 24/32, 700 |
| `--t-title-2` | Empty-state title | 20/28, 600 |
| `--t-title-3` | Card title, wordmark | 17/24, 600 |
| `--t-headline` | Buttons, labels, list titles | 15/22, 600 |
| `--t-body` | Reading text, ledes | 15/24 |
| `--t-callout` | Default UI text | 14/22 |
| `--t-subheadline` | Secondary UI text | 13/20 |
| `--t-footnote` | Hints | 12/18 |
| `--t-caption` | Badges, table headers | 11/16, 500 |

- Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, "Nirmala UI", "Kartika", sans-serif`.
- No web fonts.
- Times and counts use `tabular-nums`.

### Colour (light / dark)
Values were picked by **measured** contrast over glass (`docs/LIBRARIES-INVENTORY.md`, Phase 0 brief §3). The worst case is text over each tier composited on the most saturated ambient colour, before blur.

| Token | Light | Dark | Rule |
|---|---|---|---|
| `--label` | `#1d1d1f` | `#f5f5f7` | ≥ 10.6:1 on every tier |
| `--label-2` | `#55555c` (opaque) | `#a3a3ad` | ≥ 5.4:1 on thin and heavier. Apple's translucent secondaryLabel fails here, so it is not used |
| `--label-3` | `#8a8a92` | `#6e6e78` | Disabled controls only |
| `--tint` / `--on-tint` | `#3634a3` / white | `#a9a6ff` / `#14123a` | Prominent buttons 9.6:1 and 6.2:1 |
| `--red`, `--red-fill` | `#b0000e`, `#d70015` | `#ff7a72`, `#ff6961` | Recording and destructive actions |
| `--orange`, `--orange-fill` | `#a8370a`, `#ff9f0a` | `#ffb340` | Call on; warnings |
| `--green`, `--green-fill` | `#146c2e`, `#28a745` | `#30db5b`, `#30d158` | Works, allowed, saved; switches |
| `--separator`, `--fill`, `--fill-2`, `--fill-3` | translucent greys | translucent greys | Hairlines and control fills |
| `--surface-read` | `#ffffff` | `#1c1c1e` | The minutes document, transcript, tables |

**Coloured text** (red, green or orange) goes only on regular or thick glass, or on its own tinted badge.

Older pages and generated markup still use the previous variable names (`--accent`, `--muted`, `--border`, `--panel`…). These are aliased to the new tokens.

### Space, radius, motion
- Space: 4, 8, 12, 16, 24, 32, 48 (`--s1`…`--s7`).
- Hit targets: `--hit` 44 px, `--hit-compact` 36 px for dense toolbars.
- Radii: `--r-xs` 6 (chips), `--r-sm` 10 (controls), `--r-md` 14 (cards), `--r-lg` 20 (sheets, sidebar), `--r-pill`.
- Motion: `--spring` and `--spring-smooth` are CSS `linear()` curves compiled at build time from liquid-gooey's `snappy` and `smooth` springs. Durations are `--d-fast` 200 ms, `--d-base` 280 ms and `--d-slow` 350 ms. Nothing blocks input.

## Materials

| Tier | Token | Blur / saturate | Used for |
|---|---|---|---|
| Ultra-thin | `--mat-ultrathin` (40%) | 12 px / 160% | Decorative layers only; no text |
| Thin | `--mat-thin` (58%) | 20 px / 170% | Sidebar, bottom toolbars, minutes header |
| Regular | `--mat-regular` (72%) | 28 px / 180% | Cards, popup hero, job card, Ask box, details panels |
| Thick | `--mat-thick` (86%) | 36 px / 180% | Dialogs, toasts, the pill's panel |

- Every tier carries `--edge` (a 1 px inner highlight) and a layered shadow that grows with depth.
- **Depth order:** ambient background < content (regular) < toolbar (thin, sticky) < popover < modal (thick).
- **The ambient room** is `body::before`: three soft radial shapes (indigo, saffron, sky), fixed and never animated. It gives the glass something to refract.
- **Reading surfaces stay opaque.** The minutes document, transcript, usage table and meetings list use `--surface-read`. No blur sits under scrolling rows.
- **Print** removes the ambient layer and all glass. Word and email output are unchanged.
- **Blur turns on after the first paint.** `theme.js` adds `html.glass` one frame after paint, so opening a page never waits on blur.

### Fallbacks (all automatic)
- **Solid surfaces:** `prefers-reduced-transparency: reduce`, `prefers-contrast: more`, `forced-colors: active`, browsers without `backdrop-filter`, and the in-app **Settings → General → Appearance → Reduce transparency** switch (`html.solid`, its own storage key `uiSolid`). All of these give solid surfaces, a plain background, beams and metal off.
- **Reduced motion:** `prefers-reduced-motion: reduce` stops every CSS animation. Orbs draw one static frame, beams stay off, and metal is paused.
- `prefers-contrast: more` also raises secondary text to `--label`.

## Components (in `style.css`)
- **Buttons:**
  - Classes: `.primary` (prominent), `.tinted`, `.plain`, default (gray fill), `.danger` (tinted red that fills red on hover), `.danger-fill`.
  - States: pressed (scale 0.97), disabled (a readable neutral fill for `.primary`), and focus (a 3 px tint ring).
- **Fields:** inputs, selects and textareas. Focus switches to an opaque surface with the tint ring.
- **Switch:** any `input[type=checkbox][role=switch]` or `.toggle input`; iOS proportions at 44×26.
- **Segmented control:** `.segmented` / `.seg` containing buttons with `.active`. `fx/goo.js` adds the liquid thumb.
- **Chips and badges:** `.chip`, `.chipbtn`, `.badge.{ok,warn,rec,tint}`, and `.metal-badge` (metal rim with a tinted fallback).
- **Callouts and alerts:** `.warn`, `.callout`, `.callout.warnc`; popup `.alert` (red), `.alert.key` (orange).
- **App shell:** `.shell`, `.side > .side-panel`, `.navlist`, `.content`, `.card`, `.row2`, `.toggle`, `.btnrow`, `.status`, `.toolbar-bottom`.
- **Lists:** `.steps`, `ol.how`, `.checklist`, `.mini`, `.grid2`.
- **Disclosure:** `details > summary` with a rotating chevron.
- **Dialog:** `dialog` and `.dbmodal` in thick glass with a dim backdrop.
- **Progress:** `<db-orb state size>` next to the status text, which is announced politely.

## Effects layer
Removed in 1.2.0 (orbs, beams, goo thumb, liquid metal). `extension/fx/theme.js`, built by `npm run build:fx` from `fx/src/pages/theme.js`, only applies the light / dark choice. Sections below that mention orbs, the colour room or `fx/goo.js` describe the retired glass design.

## Accessibility rules
- Text contrast ≥ 4.5:1 over every tier it is allowed on (table above). `test/smoke.mjs` runs axe on every page in light and dark and fails on any serious or critical issue.
- Focus: visible `:focus-visible` ring on every control. Every page works fully from the keyboard. The pill's switch is now focusable; it was `display: none` before.
- Icon-only buttons carry `aria-label`. Status text uses `aria-live="polite"`. Orbs are `role="img"` with the status as their label.
- RTL-safe: logical properties are used, and the smoke test runs the pages with `dir="rtl"` without overflow.
- Pages hold from 360 to 1440 px and at 200% zoom without horizontal scroll.

## The colour room (fluid background)

Every page draws the same slow, fluid backdrop behind the glass: six soft blobs of colour that drift and cross-fade (`.fx-bg`, added by `fx/theme.js`, styled in `extension/style.css`). Only `transform` and `opacity` animate, so it runs on the GPU; the layer is fixed, `contain: strict`, and pauses when the tab is hidden. It is switched off by `prefers-reduced-motion` (it holds still), `prefers-reduced-transparency`, `prefers-contrast: more`, forced colours, print, and the in-app **Reduce transparency** setting (`html.solid`). Palettes: `--amb-1..3` (first set) and `--amb-4..6` (second set, cross-faded in), light and dark.

## Older names

Pages written before the glass pass use short names (`--card`, `--line`, `--muted`, `--brand`, `--rec`, `--amber`, `--ok`...). Section 5 of `style.css` maps each onto the glass tokens, so they follow light and dark and the materials automatically. New code should use the tokens named above.

## Loading and search

- Every wait shows a **thinking orb** (`fx/src/orb.js`, from thinking-orbs): the state follows the words ("Reading the transcript…" is *searching*, "Writing…" is *composing*, "Sending…" is *connecting*). Any `.spin` element a page adds is swapped for an orb.
- Any search or question field (Meetings search, Ask box, Find a meeting) carries the **border beam** while it has focus or is working (`searchBeam` in `fx/src/common.js`; CSS generated at build time from border-beam).

