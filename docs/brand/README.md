# Debrief brand assets

Built from the approved Debrief brand board: a blue rounded-square tile holding two facing panels, white on the left and light blue on the right.

## Folders

| Folder | What's inside |
|---|---|
| `01-logo-mark/` | The mark in SVG and PNG (16–1024 px). Tile variants: `primary` (blue), `navy`, `white` (grey border), `mono-black`, `mono-outline-navy`. Panel-only `glyph-*` versions have no tile. `*-small.svg` is tuned for 32 px and below, and every PNG at 16 and 32 px uses it. |
| `02-lockups/` | Horizontal and stacked lockups, with and without the tagline, in `light`, `dark`, `mono-black` and `mono-white`, plus the wordmark alone. SVG plus PNG at @1x and @2x, all on transparent backgrounds. |
| `03-chrome-extension/` | `icons/icon16/32/48/128.png` plus a `manifest-icons.json` snippet. `store/` has the 128 px store icon (96 px artwork with 16 px padding), the 440×280 small promo tile and the 1400×560 marquee. |
| `04-favicon-web/` | `favicon.ico` (16/32/48), `favicon.svg`, PNG favicons, `apple-touch-icon.png` (180, full-bleed), Android 192/512, maskable 512, `site.webmanifest` and a `<head>` snippet. |
| `05-social/` | Open Graph image 1200×630, profile avatar 400×400, banner 1500×500. |
| `06-colors-typography/` | `colors.css`, `colors.json`, `palette.png`. |

## Colours

| Name | Hex | Use |
|---|---|---|
| Primary Blue | `#1F5FBF` | Tile, buttons, links |
| Recording Red | `#C4271B` | Recording state and danger only, never in the logo |
| Navy | `#142233` | Text, dark backgrounds |
| Gray | `#E5E7EB` | Borders, dividers, light fills |
| Panel Tint | `#A9C7F5` | Right panel of the mark on blue |

## Typography

The wordmark uses Inter Display SemiBold with −0.02 em tracking, and the tagline uses Inter Regular. All text in the SVGs is converted to outlines, so the files don't need the font installed. Inter is free under the SIL Open Font License: https://rsms.me/inter/

## Usage

- Keep clear space around the mark of at least 25% of the tile's width.
- On dark backgrounds use the `primary` tile with white text (the `dark` lockups).
- Use the `mono-*` versions for single-colour print, embossing and fax.
- Don't recolour the panels, add effects or stretch the tile.
