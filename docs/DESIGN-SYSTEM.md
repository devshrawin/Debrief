# Debrief · Harbor design system

## Principles

1. **Solid, not glass.** Opaque surfaces, hairline borders and soft shadows. No blur and no background gradients.
2. **One loud thing per view.** One blue primary button per view. Red (`rec`) only ever means recording or danger.
3. **Rows, not paragraphs.** A setting is a label, one sentence and a control. Longer explanations move behind Advanced or a link.
4. **Same rhythm everywhere.** One top bar, one page header (title, meta, actions on the right), one card and one row list.
5. **Centred.** Content sits in a centred column at every width; nothing hugs the left edge of a wide window.
6. **Say what happened.** Status is a badge or a banner: the fact in bold, then what happens next.

## Colour

Light is the default. Dark applies through `prefers-color-scheme`, or `data-theme="dark"` on `<html>`. Every text pair is at least 4.5:1, and every control border and focus ring at least 3:1.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#eef2f6` | `#0f1620` | Page background behind cards and documents. |
| `surface` | `#ffffff` | `#16202c` | Cards, popup body, the minutes document (opaque reading surface). |
| `surface-2` | `#e6ecf3` | `#1c2836` | Rails, table headers, segmented track, hover fill. |
| `border` | `#d8e0ea` | `#263445` | Hairline borders and dividers. |
| `border-strong` | `#8496ab` | `#5b6f87` | Input and control borders (3:1 against surface). |
| `text` | `#142233` | `#e6edf5` | Primary text on bg, surface and surface-2. |
| `text-2` | `#4a5b70` | `#a3b3c6` | Secondary text: meta, descriptions, hints. 4.5:1 on surface-2. |
| `text-3` | `#7d8ca0` | `#6d7f94` | Disabled text and placeholders only. Not for content. |
| `primary` | `#1f5fbf` | `#6aa5f0` | Main button fill. One per view. |
| `primary-hover` | `#194f9f` | `#8ab8f4` | Main button hover. |
| `on-primary` | `#ffffff` | `#0b1420` | Text and icons on primary. |
| `accent` | `#1f5fbf` | `#6aa5f0` | Brand accent: links, selected nav, focus ring, active tab. |
| `accent-text` | `#1d58b3` | `#8ab8f4` | Accent used as text on surface (4.5:1). |
| `accent-soft` | `#e4eefb` | `#1a3352` | Selected nav background, info banner, accent badge fill. |
| `focus` | `#1f5fbf` | `#8ab8f4` | Focus ring (3:1 against bg and surface). |
| `rec` | `#c4271b` | `#d92d20` | Recording: Start recording fill, record dot, Stop. |
| `on-rec` | `#ffffff` | `#ffffff` | Text on rec. |
| `rec-text` | `#b42318` | `#ff8a80` | Recording and danger as text. |
| `rec-soft` | `#fdecea` | `#3a1512` | Recording and danger banner fill. |
| `warn-text` | `#8a4b00` | `#f5b759` | Warning text and icon. |
| `warn-soft` | `#fff4e0` | `#2e2210` | Warning banner fill (quota, free tier). |
| `warn-border` | `#efc27d` | `#5c4317` | Warning banner border. |
| `ok-text` | `#116b37` | `#5cd08a` | Success text and icon: Saved, Emailed, Present. |
| `ok-soft` | `#e6f4ea` | `#12291b` | Success badge fill. |
| `pill-bg` | `#132031` | `#1a2839` | In-call pill and its card. Always dark: it floats over Google Meet. |
| `pill-text` | `#eef3f9` | `#eef3f9` | Text on the pill. |
| `pill-text-2` | `#a7b6c9` | `#a7b6c9` | Secondary text on the pill. |
| `pill-border` | `#2a3b51` | `#34475f` | Pill edge. |
| `scrim` | `rgba(15, 30, 50, 0.4)` | `rgba(0, 0, 0, 0.6)` | Modal backdrop. |

`text-3` is only for placeholders and disabled text.

## Type

System fonts only: `-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, "Nirmala UI"`. Nirmala UI covers Hindi and Malayalam on Windows.

| Class | Size / line | Weight | Use |
|---|---|---|---|
| `.t-display` | 28/36 (24/31 under 600px) | 700 | Page titles, tour steps |
| `.t-title` | 20/28 (Settings: 24/32) | 700 | Section page titles |
| `.t-heading` | 15/22 | 600 | Card headings |
| body | 14/21 | 400 | Default |
| `.t-small` | 13/19 | 400 | Descriptions, meta |
| `.t-label` | 12/16 | 550 | Table headers, badges |
| `.t-overline` | 11/16, uppercase, +0.06em | 600 | Group labels, minutes sections |
| `.doc p` | 15/25, max 72ch | 400 | Minutes and transcript |

## Space, radius, depth, motion

- **Space:** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 (`--space-1` to `--space-8`).
- **Radius:** `--radius-sm` 8 (badges, small buttons) · `--radius-md` 10 (buttons, inputs) · `--radius-lg` 16 (cards, rows, modals) · pill 999.
- **Controls:** 38px default, 30px small, 46px large.
- **Shadow:** `--shadow-1` resting cards · `--shadow-2` menus, toasts · `--shadow-3` modals.
- **Motion:** 140ms `cubic-bezier(.2,.7,.2,1)`, hover and toggle only. All motion is off under `prefers-reduced-motion`.

## Components (all in `style.css`)

| Component | Classes |
|---|---|
| Button | `.btn` + `.primary` `.plain` `.link` `.danger` (`.solid`) `.rec`, sizes `.sm` `.lg` `.icon` `.round` `.block`, `:disabled` |
| Menu | `details.menu > summary.btn + .menu-list` |
| Field | `.field > label + .input/.select + .hint(.error)`, `.input-group`, `.search` |
| Switch | `button.switch[role=switch][aria-checked]` |
| Segmented | `.seg` (`.block`, `.sm`) with `button[aria-pressed]` |
| Radio card | `label.choice > input[type=radio] + .choice-b` |
| Badge, count, status, avatar | `.badge` (`.ok` `.warn` `.rec` `.accent`), `.count`, `.status` (`.done` `.now`), `.avatar` |
| Card | `.card` (`.flat`), `.card-head` `.card-body` `.card-foot`, `details.card` |
| Rows | `.rows > .row > .row-label + .row-ctl`, `.group-head`, `a.row` |
| Banner | `.banner` + `.info` `.warn` `.danger` `.ok` |
| Modal | `dialog.modal` + `.modal-head` `.modal-body` `.card-foot` |
| Toast | `.toast` (fixed, bottom centre) |
| Table | `.table-wrap > .table` (`.stack-sm` with `data-label` on cells) |
| Empty | `.empty > .empty-icon + h + p + action` |
| Loading | `.spinner`, `.progress > i` (`.ok` `.warn`), `.skeleton` |
| Chrome | `.topbar > .topbar-inner`, `.brand`, `.mark`, `.crumbs`, `.tabs [role=tab]` |
| Page | `.page` (`.narrow`), `.page-head`, `.with-rail` + `.rail-stack` |
| Settings | `.settings > .settings-rail + .settings-main > .settings-page`, `.setup-card`, `.provider-grid`, `.danger-zone` |
| Tour | `body.welcome`, `.stepper`, `.welcome-card`, `.how`, `.opt-grid` |
| Popup | `body.popup`, `.popup-head` `.popup-body` `.popup-foot`, `.timer`, `.meter-row` |
| Pill | `pill.css`: `.dbp .pill .chip .x .card .meter .note .switch .stop .remind` |

## Layout rules

- **Top bar** (`.topbar-inner`) and **page** (`.page`) share one centred 1240px column, so the logo lines up with the title.
- **Minutes, Live:** document plus a 320px side column of tools at 1040px and wider; below that the tools sit under the document.
- **Actions, Ask:** a single centred 880px column (`.page.narrow`). Ask centres its heading.
- **Settings:** a 280px menu that is always as tall as the window, with its groups spread to fill it (`justify-content: space-between`), and the setup card and help at the bottom. The content is a centred 760px column. Under 760px the menu becomes the Settings home page.
- **Tour:** a centred 620px column with the step tracker above one card.
- **Popup:** 380px (works 360–400px), header, body, footer; one filled control per state.

## Logo

Two facing panels (white left, light blue right) on a rounded blue square. Brand pack in `docs/brand/` (mark, lockups, store and social images, colours). Use `icon-small.svg` at 32px and below; `icon-recording.svg` (red tile, white dot) is the recording state; `icon-mono.svg` is for one-colour uses. Recording Red is never part of the logo.
