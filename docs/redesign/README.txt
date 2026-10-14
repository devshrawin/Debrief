Debrief redesign - design source files

Each .dc.html file is one artboard from the Debrief redesign canvas.
canvas.json holds the canvas layout (positions, sizes, titles).

Main.dc.html            Foundations: colour tokens (light/dark), type, buttons, components, dialogs, alerts, empty states
Brand.dc.html           Logo, toolbar icon states (idle, call-on glow, REC, attention), store listing
Popup.dc.html           Toolbar popup (360 px): idle, recording, finishing, meetings, other states
Pill.dc.html            On-page recording pill and detail panel
Tour.dc.html            First-run tour, 12 steps
SettingsStart.dc.html   Settings > Get started (incl. Check my setup)
SettingsVoices.dc.html  Settings > Voices
SettingsUsage.dc.html   Settings > Usage
Minutes.dc.html         Minutes page (minutes + transcript tabs)
Ask.dc.html             Ask your meetings
Email.dc.html           Minutes output in the official Amnex format (A4 / Word / email)

Notes
- The CSS tokens and markup can be lifted straight into the extension pages; ids from the current HTML were kept.
- The files rely on the Design canvas runtime (support.js) for live states and tweaks. Opened directly in a
  browser, the static markup shows but interactive states and {{placeholders}} will not resolve.
- Sample names, figures and [PLACEHOLDERS] are illustrative only.
