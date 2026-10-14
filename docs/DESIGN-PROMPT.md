# Debrief redesign: master prompt and one prompt per element

How to use this: paste the **Master prompt** into Claude Design first, so it holds the product, the rules and the design language. Then paste one **element prompt** at a time. Each element prompt is self-contained about content and states, and only points back to the master for the shared rules. Ask for HTML + CSS + a little vanilla JS for each, since the real extension has no framework.

---

## Master prompt (paste this first)

You are redesigning the interface of **Debrief**, a Chrome extension that records the audio of an online meeting tab (Google Meet first; also Zoom, Teams, Webex and others in the browser), transcribes it, and writes the minutes of meeting (MOM). People use it at work, often right before or after a meeting, in a hurry, and some are not technical. It must feel calm, trustworthy and quick, never like a developer tool.

**What the product does, so the design fits it**
- Starts and stops recording of the meeting tab. While recording it shows a timer, a level meter for the meeting audio and one for the user's own mic, and warns when a service quota is hit.
- Transcribes speech in English, Hindi, Malayalam and mixes of them (Devanagari and Malayalam script appear on screen all the time).
- Writes structured minutes (summary, discussion, decisions, action items with owner and due date, risks, open questions, attendance), which the user can read, edit, copy, download as Markdown or Word, print to PDF, email to themselves, and share with colleagues.
- Optional: says who is speaking by voice recognition (a best guess, always labelled "Unknown speaker" when unsure), learns recurring voices across meetings, and lets the user play a short sample of an unnamed voice to name it.
- Lets the user ask questions across all past meetings and shows the source of every answer.
- Privacy is a selling point: keys and audio stay in the browser, only the providers the user chose receive anything, and voice data never leaves the computer. The interface should make that visible and honest, in plain words.

**Surfaces to design (each gets its own prompt below)**
1. First-run tour (`welcome.html`), 12 steps
2. Toolbar popup (360 px wide)
3. On-page recording pill and its detail panel (floats over the meeting)
4. Settings (`options.html`), 7 pages: Get started, General, Speech to text, Minutes, Email, Voices, Usage
5. Minutes page (`mom.html`): header, people and context box, share box, minutes, transcript tab
6. Ask your meetings (`ask.html`)
7. In-page dialog, alerts, empty and error states
8. Email, Word and PDF layout of the minutes
9. Logo, icon states and the amber "call detected" glow

**Hard technical rules (the design must respect these)**
- Plain HTML, CSS and vanilla JS. No frameworks, no build tools, no CDN, no web fonts loaded from the internet (the extension blocks them). Use a system font stack that renders Devanagari and Malayalam well (for example `"Google Sans", "Segoe UI", system-ui, "Nirmala UI", "Kartika", sans-serif`) and leave generous line height for Indic scripts (at least 1.6).
- Light and dark themes via `prefers-color-scheme`, both fully designed, defined as CSS variables on `:root`.
- Fully keyboard operable, visible focus rings, contrast at least WCAG AA, touch targets at least 36 px, respects `prefers-reduced-motion`.
- The popup is 360 px wide; Settings and the minutes page are desktop pages (min 760 px) that must also hold at 480 px.
- The on-page pill lives in a closed shadow root over a page I do not control: it must be self-contained CSS, small, never cover the meeting's own controls, and never intercept clicks outside itself.
- Text must survive translation and long names: no fixed widths for text, ellipsis for long titles, wrap everything else.
- Never show a secret (API key, relay URL, secret) on screen once saved; use dots and a "Replace" action.

**Design language to start from (change it if you can do better)**
- Brand: deep indigo (`#3a33a8` light, `#9d97ff` dark) with a soft indigo tint (`#eceafc` / `#25234a`) for selected states.
- Warm saffron/amber (`#ff7a1a`, glow `#ffb347`) is reserved for "a call is on, you are not recording" and for gentle warnings.
- Red only for an active recording (REC) and destructive actions; green only for "working / allowed / saved".
- Cards on a soft grey page (`#f6f7f9` light, `#1b1d21` dark), 14 px radius, hairline borders, very light shadow. Section titles as small uppercase labels.
- Tone of voice: short, direct, no jargon, say what happens and what it costs ("Sent to Google", "Stays on this computer"). Never blame the user.

**What I want back for every element:** the full HTML and CSS, every state listed in the prompt rendered or toggleable (default, hover, focus, active, disabled, loading, empty, error, success, dark mode), the exact copy used, and a short note on any accessibility decision. Keep element ids and data attributes listed in the prompt unchanged so the existing logic keeps working.

---

## 1. First-run tour (`welcome.html`)

Design a guided, full-page tour of 12 steps with a left step list and a main stage. Goal: someone who has never seen Debrief is set up in about five minutes and trusts it. Steps: **Welcome, Gemini key, Microphone, You (name and languages), Names and terms, Recording, Who is speaking (optional), Email the minutes (optional), Sharing (optional), Local models (optional), Usage and limits, Done**.

- Layout: left rail with numbered steps (done = check, current = filled, optional = small "optional" tag), a stage with a kicker ("Step 5"), a large title, a one-line lede, then cards. Footer with Back, Skip and a primary Next ("Start the tour" on the first step, "Finish" on the last). Progress must be visible and every step skippable.
- Welcome step: a three-or-four-item "How Debrief works" illustration (join a meeting, press record, minutes appear, share), plus a short privacy promise.
- Key step: password field, "Test my key" button with live result (working / not working with the reason), link to get a free key, and a clear callout that Google's free tier may use audio to improve products (confidential meetings: use a paid key or a local model).
- Microphone step: "Allow microphone" button, live status, what happens if skipped.
- You step: name field, multi-select language chips (English, Hindi, Malayalam, Tamil, and more), minutes language dropdown.
- Recording step: numbered how-to ("In the meeting"), toggles (stop automatically, stop after silence), optional extras (pill on the page, caption names).
- Who is speaking step: explanation card with three honest bullets, two toggles (name by voice, learn on its own), a button that opens Settings, a hint that it can be skipped.
- Email step: copy-the-script button, five numbered sub-steps, web app URL field with live validation, toggles (send automatically, attach PDF, Word, transcript), a "Send a test email" button with result.
- Done step: a checklist summary (key saved, mic allowed, name set, names, email, sharing) with ticks or "optional, not set", and a primary Finish.
- States: key test loading/ok/failed, URL invalid, restart of the tour from the popup, narrow window. Keep ids such as `stepsNav`, `stage`, `back`, `next`, `skip`, `count`.

## 2. Toolbar popup (360 px)

Design the popup that opens from the toolbar icon. It has three modes. Keep it light: one primary action at a time.
- **Idle:** brand header (logo, name, a small Settings link and Tour link), a big primary "Start recording this tab" button, the last meeting as a small card ("Open minutes"), a quick tabs row (Home / Meetings), and an "Ask a question" link. If a call is detected on the current tab and Debrief is not recording, show an amber banner "A call is on. Start recording?".
- **Recording:** header turns to recording state (red dot, timer), two live meters ("Meeting audio", "Your mic") with plain labels (good / quiet / silent), a switch "Include my microphone" with a state line that says what Debrief sees of the call's mute button (muted in the call, unmuted, button not found), counts (transcript pieces, errors), an alert area (API limit, key rejected, microphone silent) with a clear next step, and a destructive-looking but safe "Stop and write minutes" button.
- **Finishing:** progress text ("Finishing transcription…"), a link to the minutes page.
- **Meetings tab:** searchable list of past meetings (title, date, duration, a small "emailed" badge), open / delete, an empty state.
- A "Check page detection" link that reveals what Debrief can read from the call page (mute button, people, captions) as a small readable panel.
- States: no key configured (guide to Settings), Gemini limit near (80 percent warning), error, offline. Keep ids `start`, `stop`, `micToggle`, `micState`, `lvMic`, `lvMicT`, `alert`, `alertTitle`, `live`.

## 3. On-page recording pill and detail panel

Design a tiny floating capsule that sits over the meeting page, only while recording, and a detail panel that opens **when the pill is clicked (never on hover)** and closes on a second click, a click elsewhere, or Escape.
- Pill: a red recording dot, a four-bar equaliser that moves with the meeting audio, the timer, an optional small amber "Limit" chip, and a mic button with three clear states (green "Mic on", grey "Mic off", amber "Muted in call"). Draggable, remembers its place, snaps to screen edges, about 36 px tall. Default position top right, away from Meet's own bottom toolbar. It must stay visible in browser full screen.
- Panel (about 260 px): two level meters, a one-line mic state, the counts, an alert box if a quota or key problem exists, a switch to include the mic, and a full-width "Stop and write minutes" button.
- States: idle level, loud, silent audio warning ("No audio is arriving"), alert, muted, dragging, panel open, dark and light page backgrounds (it floats over video, so it needs its own solid dark surface and a subtle border to read on any background).
- Constraints: closed shadow root, self-contained CSS, `pointer-events` only on its own box, nothing wider than the panel, no layout shift for the page.

## 4. Settings (`options.html`)

Design a settings app with a left navigation (logo, 7 numbered items, footer links "Take the tour" and "Setup guide") and a content column, plus a sticky "Save changes" bar that shows "Saved" feedback. Each page: title, one-line lede, then cards with a small uppercase title. Reusable pieces to design once: toggle row (title, sub text, switch), field row (label, input, hint), secret field with Replace, segmented control, status chip, callout (info, warning), code block with Copy, data table, chip multi-select.

**Page 1 Get started:** a four-item checklist with ticks (key, microphone, name and language, email), a Gemini card with main key and backup key (secret fields, a plain hint about per-project quotas), the Google free-tier privacy callout, and a **Check my setup** card: button, result list with ✓ ! ✗ rows and a "Copy the result" button (safe to paste, never shows a key).

**Page 2 General:** Profile (name), Microphone (include mic, pause mic while muted in the call, allow button and permission status), Meeting pages (show the pill, work with other meeting apps), Recording (auto stop on meeting end, stop after N quiet minutes, who is in the call: use Meet's captions or turn them on), Names and terms (dictionary textarea, "Learned automatically" list with one-click approve or dismiss, auto-accept switch), Language (multi-select chips and minutes language).

**Page 3 Speech to text:** provider choice (Gemini, Sarvam, Deepgram, Whisper-compatible, local), provider-specific fields shown only when chosen, model choice, a language and hint area, local Whisper preset buttons.

**Page 4 Minutes:** provider choice (Gemini, Claude, OpenAI-compatible, local), model, minutes mode (Thorough or Quick, with a plain explanation of the cost), checklist options, local model advice.

**Page 5 Email:** Connect (copy script, numbered steps, web app URL with live validation, test button with result), Delivery (to, automatic, attachments), Sharing with others (default list and lists per recurring meeting, to/cc/bcc, allow whole company domains, copy script with these people allowed), Calendar (look up who was invited), Attachments.

**Page 6 Voices:** this is new and sensitive, design it with care:
- Card "Recognise who is speaking": the on/off switch with a "best guess" note.
- Card "Learn voices on its own": switch and an honest paragraph (needs two meetings, can mix up similar voices, tell colleagues).
- Card "Short samples of unnamed voices": switch and a plain statement that this is the only audio kept, where it is kept, and when it is deleted.
- Card "Privacy": three short facts (stays in the browser, only 256 numbers are stored, how to delete).
- Card "Enrolled people": a list; each row shows name, a badge (Recorded / Learned, in use / Learned, still learning / Unnamed voice), the languages and seconds of speech, and actions: ▶ Play sample (only for unnamed voices that have one), Rename, Re-record, Add recording, Export, Merge into…, Delete. Empty state: "Nobody yet".
- Card "Add a person": name, language segmented control (English, हिन्दी, മലയാളം, Speak freely), a reading prompt in large readable text in that language, Record / Stop / Play back, a live level meter and timer ("aim for about 20 s"), a status line, Save and Cancel. Plus states: no microphone, too little speech, saved.
- Card "Unnamed voices in your latest meeting": groups with example timestamps and a name field per group.
- Card "Share voices": export and import with a consent warning. Card "Forget": a destructive "Forget all voices".

**Page 7 Usage:** range tabs (Today, 7 days, 30 days), a table (service and model, used for, requests, failed with rate-limit count, tokens in/out, audio minutes, **cost if paid**, a "left today" meter), a totals line, a limits textarea, a prices textarea, a Reset counters button. Show the "~" estimate convention clearly.

States everywhere: saved, unsaved changes, validation error, loading, disabled because another option is chosen, narrow width.

## 5. Minutes page (`mom.html`)

Design the page opened after a meeting. Top: brand and meeting title (editable), date, duration, participants line, status chips (emailed, model used). A collapsible **People, names and context** box (who was in the meeting, one per line; "Fix a name everywhere" with heard-as and should-be fields and a remember tick; suggested fixes as chips; other context). Tabs: **Minutes** and **Transcript**.
- Minutes tab toolbar: Generate / Regenerate (primary), Re-read transcript, Stop, a status line, then Edit, Copy, .md, Word, Print / PDF, Email me. A collapsible **Share these minutes with others** box (recipients, To/Cc/Bcc, Add everyone invited, Add people who were absent, Share). An **Ask about this meeting** box. The minutes article itself: typography for headings, bullet lists, tables (action items with owner, due date, timestamp and quote, and the **Attendance table: Person, Invite, In the meeting (Yes / Absent), Joined, Left, Note**), and footnotes. A distinct style for the "Added by the completeness check" section and for the footer note. Streaming state while writing.
- Transcript tab: rows of time, speaker label and text; speaker labels styled by kind (you, others, a named person, **Unknown speaker**, disputed by captions "Priya (captions say Ravi)"); download and delete buttons; an info line ("speakers named by voice recognition, a best guess").
- States: no minutes yet, generating, failed (with the reason and retry), recovering missing audio, errors during transcription, print layout (clean A4, no controls).

## 6. Ask your meetings (`ask.html`)

A focused page: title, one-line lede, a scope selector (all meetings, last 7 or 30 days), a count of meetings searched, a large question box with a send button, a streamed answer with the **source of every point** (meeting title, date, time, link), and a short privacy note about what is sent. States: empty, searching, no match found, no model configured, error, long answer.

## 7. Dialogs, alerts, empty and error states

Design a small system used everywhere: modal dialog (title, text, optional input or select, up to three buttons, one primary, a danger style), toast or inline status line, alert banner (info, warning, error, with one clear action), skeleton or spinner, and empty-state blocks with a friendly line and one action. The dialog replaces the browser's own confirm and prompt (Chrome silently suppresses those), so it must be focus-trapped, close on Escape, and read well on a phone-width window.

## 8. Email, Word and PDF layout of the minutes

Design the minutes as an HTML email (inline styles only, 600 px wide, readable in Gmail and Outlook, dark-mode friendly), a Word-friendly version, and an A4 print/PDF version. Content in order: title, a meta row (date, duration, participants), summary, discussion, decisions, an action items table (owner, due date, timestamp), risks and open questions, the attendance table, and a small footer ("Written by Debrief with <model>"). Tables must keep borders and shading when pasted into Word, and long Hindi or Malayalam text must wrap correctly.

## 9. Logo, icon states and the call-detected glow

A simple, memorable mark that works at 16 px (toolbar) and 512 px (store): think a speech bubble or sound wave resolving into lines of text, in the indigo palette. Provide four toolbar icon states: idle, **amber glow** (a call is on and nothing is recording), **REC** (red badge), and error. Include a one-line store description and a 1280×800 store screenshot layout.

---

## After the first pass: review prompt

"Review everything you produced against the master prompt. List any place where (1) a state is missing, (2) contrast is below AA, (3) Hindi or Malayalam text would overflow or clip, (4) a secret could appear on screen, (5) the privacy wording could mislead, or (6) an element would block the meeting page. Fix each, and give me one consolidated stylesheet of the shared tokens and components."
