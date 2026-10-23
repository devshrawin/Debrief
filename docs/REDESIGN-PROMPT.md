ROLE
You are a senior product designer and front-end engineer. The project is a Chrome Manifest V3 extension (repo "Debrief Pro", branch `pro`; source in src/, built with `npm run build` into extension/dist/; tests: `npm test`, `node test/chrome-smoke.mjs`, `node test/chrome-job.mjs`; screenshots: `node scripts/screenshots.mjs`). Read README.md and docs/AUDIT.md first. It records a meeting tab, transcribes it, and writes minutes. Its surfaces are: popup, minutes page (with countdown card, "Who was speaking?" box, attendance table, Ask box, share box), Settings (Get started, General, Speech to text, Minutes, Email, Voices, Usage), first-run tour, Ask page, the on-page Meet pill, notifications, and the printed / Word / email minutes.

GOAL
1. KEEP the name "Debrief". Do not rename anything.
2. REDESIGN the whole system into one coherent, premium GLASS design language that follows Apple's Human Interface Guidelines.
3. USE elements from the attached Libraries.dev folder where they genuinely improve the product. (The shared copy is source only: each package's src, spec, README and licence, plus the demo sites' src. It has no node_modules, built dist, demo videos or images, or native iOS / React Native ports. Live demos are linked in each package README.)

SET UP YOUR TOOLS FIRST (report what worked)
- Agent skills: `npx modern-web-guidance@latest install --choose` (select `chrome-extensions` and `modern-web-guidance`).
- Chrome DevTools for agents: `claude mcp add chrome-devtools --scope project -- npx chrome-devtools-mcp@latest --categoryExtensions --autoConnect`, then allow remote debugging at chrome://inspect/#remote-debugging. Use it to install and reload the extension, open every surface (popup, options, minutes, tour, Ask, service worker, offscreen document), read console errors and take performance traces.
- Create and maintain CHROMEWEBSTORE.md (format from the chrome-extensions skill): listing text under the name Debrief, single-purpose statement, a justification for every permission in manifest.json, and privacy wording. Privacy facts: audio and text go straight from the browser to the provider the user chooses; nothing is stored on any server of ours; voice fingerprints and optional short clips stay on the device.

WORK IN PHASES, ONE COMMIT PER PHASE. After each phase run `npm run build`, `npm test`, `node test/chrome-smoke.mjs`, `node test/chrome-job.mjs`; fix or update tests honestly (never weaken them to pass). At the end regenerate docs/img with `node scripts/screenshots.mjs`, update README.md, docs/*, docs/AUDIT.md.

PHASE 0: INVENTORY AND DESIGN BRIEF (no code yet)
- Read the Libraries.dev folder: README.md, packages/{border-beam, thinking-orbs, liquid-gooey, metal-fx, img-fx}, their README.md, src/, spec/, and the demo sites in sites/. These are React 18 libraries by Jakub Antalik (MIT). Write a one-page inventory of every component, prop and effect you can use, with its cost (bundle size, canvas / WebGL, idle CPU).
- Audit all current surfaces (screenshots in docs/img plus the live pages in Chrome) and list what is inconsistent.
- Produce the design brief: the token set, a component list, and a screen-by-screen plan. Include a mapping of Libraries.dev pieces to places (below). Wait for my approval of the brief before Phase 1.

LIBRARIES.DEV: HOW TO USE EACH (use only where it earns its place)
- border-beam (animated border glow): the "recording now" state of the popup and the pill (pulse variants for listening), the active "writing the minutes" card, focus state of the Ask box and key inputs, and the primary call to action. Static and calm when idle.
- thinking-orbs (nine dotted-orb loader states, plain 2D canvas): replace every spinner and skeleton with an orb whose state matches the job stage: reading the transcript, writing, checking, transcribing failed audio, emailing, listening. Map job states in src/jobstate.js and the status text to orb states.
- liquid-gooey (Morph and Move): the segmented controls (Online meeting / In a room, Organisation template / Standard, Home / Meetings, Minutes / Transcript), the sliding tab and selection indicators, menu and "More" popovers that morph out of their button, and the avatar group of attendees and voices.
- metal-fx (liquid-metal ring, MetalText, MetalBadge): small, high-value accents only: the product wordmark, the record button ring, status badges such as "New" and "Emailed". It is WebGL: use sparingly, never on a scrolling list, and pause when hidden.
- img-fx (WebGL loading mosaic): optional, tour hero or empty states only. It needs three.js: only include it if the size and CPU budget allows, otherwise skip it and say so.
- Integration rules: the extension is vanilla JS bundled by esbuild and the libraries are React. Decide per component, with evidence: either (a) bundle React only into the pages that need it, or (b) port the effect to vanilla JS/CSS (border-beam is mostly CSS gradients, masks and @property; thinking-orbs is plain canvas; each library has spec/ and port plans). Do not ship the whole of every library. Respect MV3 CSP (no remote code, no eval). Keep the popup opening fast. State the added package size for each choice. Keep the MIT licences and attribution to Jakub Antalik in NOTICE.md (metal-fx also carries an Apache-2.0 NOTICE for Paper Shaders: keep it).

DESIGN SYSTEM: GLASS + APPLE HIG
One shared token stylesheet for every page (extension/style.css), no per-page one-off colours.
Glass (material, not decoration)
- Four material tiers as tokens (ultra-thin, thin, regular, thick): tinted rgba background, `backdrop-filter: blur() saturate()`, a 1px inner highlight border, layered soft shadows.
- A calm, slightly colourful ambient background (mesh gradient or blurred shapes, static or very slow) so the glass has something to refract.
- Cards, sheets, popovers, toolbars, sidebar, menus, toasts, dialogs and switch tracks each use the tier that matches their depth, in one consistent order: background < content < toolbar < popover < modal.
- The minutes document itself is an opaque reading surface: glass frames it and never sits behind body text. Printed, Word and email output stay print-safe (no glass).
- Performance: limit stacked backdrop-filters, no blur on long scrolling lists or table rows, measure popup open time and minutes-page scrolling in DevTools; fall back to solid tinted surfaces where frames drop.
Apple HIG
- Principles: clarity, deference (content first), depth.
- Typography: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable", system-ui`; the HIG type scale (large title, title 1-3, headline, body, callout, subheadline, footnote, caption) as tokens; tabular numbers for times and counts; sentence-case labels.
- Layout: 8-pt grid, 44 px minimum hit targets, continuous-corner (squircle-like) radii by size tier, a sidebar and content layout for Settings, a large title that collapses on scroll where it fits.
- Colour: semantic tokens (label, secondary label, separator, fill, tint, system red / orange / green) with automatic light and dark; one brand accent; destructive actions in system red, kept apart.
- Controls: iOS-style switch, segmented control, prominent / tinted / plain buttons, pull-down menus, sheet-style dialogs, inline progress, toasts; clear disabled, pressed and focus states.
- Motion: spring-like easing, 200-350 ms, never blocking the task.
- Accessibility (hard requirements): text contrast at least 4.5:1 over every glass tier in light and dark (add a scrim where it fails); honour `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast: more` by switching to solid surfaces and calming every library effect; visible `:focus-visible`; full keyboard use; labelled icon buttons; `aria-live` for job status; RTL-safe; usable at 200% zoom. Popup works at 360-400 px; minutes page from 360 to 1440 px.

LOGO (Phase 1)
- A refreshed logo and icon set is produced separately from docs/LOGO-PROMPT.md. Use the current icons (extension/icons) until it is delivered, then drop the new files in (all sizes plus the glow variants) and update scripts/make-icons.mjs.
- Keep the generic-by-default organisation template and the "Use Amnex preset" button working.

FUNCTIONAL GUARDRAILS
- No behaviour regressions: background minutes job, live progress on the minutes page, countdown and hold, resume after restart, one email only, voice naming with Play, attendance "Name (address)", quota warning with its close button, the two-step tour.
- No new network requests, no remote fonts or scripts, no analytics.
- Do not change privacy behaviour or defaults unless asked.

DELIVERABLES
1. The design brief (Phase 0) for approval.
2. The redesigned extension (same name), one commit per phase.
3. A short design-system doc (tokens, materials, components, accessibility rules) in docs/.
4. New screenshots in docs/img and a redesigned README.
5. CHROMEWEBSTORE.md.
6. A final report: what changed, bundle-size impact of each Libraries.dev piece, tests run, what you could not verify, and what I must test live (a real Meet recording, the automatic email, the pill on a Meet page).
