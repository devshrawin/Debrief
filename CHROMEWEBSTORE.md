# Chrome Web Store listing: Debrief

## Name
Debrief – Meeting Minutes

## Short description (≤ 132 characters)
Records your Meet, Zoom or Teams tab and writes the minutes in English, Hindi or Malayalam. Keys and audio stay in your browser.

## Detailed description
Debrief turns an online meeting into clear minutes of meeting.

- Record the meeting tab in Google Meet, Zoom, Microsoft Teams, Webex and other browser meeting apps with one click or Alt+Shift+M.
- Transcription handles English, Hindi, Malayalam and mixes of them.
- The minutes cover a summary, discussion, decisions, action items with owners and due dates, risks, open questions and attendance.
- Read, edit, copy, download as Markdown or Word, print to PDF, email them to yourself, or share them with colleagues.
- Ask questions across all your past meetings. Every answer shows where it came from.
- Optional: name speakers by voice. This runs entirely on your computer.

You choose the services that do the work: Google Gemini (a free key is enough), Sarvam, Deepgram, OpenAI-compatible, Anthropic Claude or local models. Debrief has no server of its own.

Please tell people before you record them.

## Single purpose
Debrief records the audio of a meeting tab the user chooses and turns it into a transcript and minutes of meeting.

## Permission justifications

| Permission | Why Debrief needs it |
|---|---|
| `tabCapture` | Records the audio of the meeting tab the user asks to record. |
| `offscreen` | MV3 service workers cannot hold a media stream, so recording and audio encoding run in an offscreen document. |
| `storage` | Saves settings, the user's own API keys and meeting metadata locally. |
| `unlimitedStorage` | Transcripts, short audio pieces waiting to be retried, and voice fingerprints for long meetings can exceed the default quota. All of it stays on the device. |
| `activeTab` | Identifies the current tab when the user clicks the toolbar button, so that tab can be recorded. |
| `scripting` | Injects the small on-page recording pill and the mute or caption detector into a meeting tab, and opens the Debrief panel over the current page when the user clicks the toolbar button. |
| `notifications` | Tells the user when recording stops and when the minutes are ready or emailed. |
| Host: `meet.google.com` | Reads the call's mute button, people list and captions so the transcript can name speakers and pause the user's mic while muted. |
| Hosts: `api.sarvam.ai`, `api.deepgram.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.openai.com`, `api.groq.com` | Sends audio or text **only** to the speech-to-text or minutes provider the user selected, using the user's own key. |
| Hosts: `script.google.com`, `script.googleusercontent.com` | Delivers the minutes by email through an Apps Script web app the user deploys in their own Google account. |
| Optional hosts: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | Asked for at run time only, when the user adds another meeting site, a custom OpenAI-compatible endpoint, or a local model (Whisper or Ollama on this computer). |
| `web_accessible_resources`: `popup.html` on `<all_urls>` | The Debrief panel is the popup page shown in a frame on top of the current page, so the page shows through its glass background. Only the user's own click on the toolbar button opens it. |
| Content scripts on Zoom, Teams, Webex, Whereby, Jitsi, 8x8, GoTo, BlueJeans, Chime, Zoho Meeting, Skype | Shows the recording pill and detects when a call starts or ends, so recording can stop automatically. No page content is sent anywhere. |

## Remote code
No. All code is in the package. There is no `eval`, and no scripts, fonts or styles are loaded from the network.

## Data use (privacy practices tab)
- **What is collected:** audio of the recorded tab and microphone, transcripts and minutes. These are user-generated content.
- **Where it goes:** straight from the browser to the provider the user chooses, using the user's own key. **Nothing is stored on any server of ours; Debrief has no server.**
- **Email:** when the user turns email on, the minutes pass through an Apps Script the user deploys in their own Google account.
- **Voice fingerprints, and optional short clips of voices:** these stay on the device and are never uploaded.
- **Not sold, not used for advertising, not used for creditworthiness.**
- Google's free Gemini tier may use submitted content to improve Google's products. Debrief says so in setup and recommends a paid key or a local model for confidential meetings.

## Privacy policy wording (to host at the listing's privacy URL)
> Debrief runs entirely in your browser. Audio and text go directly from your browser to the speech and AI services you select, under your own account and key. We operate no server and receive none of your data. Voice fingerprints and any optional voice clips stay on your device. You can delete any meeting, or all voice data, at any time in the extension.

## Privacy policy URL
`PRIVACY.md` in this repository, as a public page: `https://github.com/devshrawin/Debrief/blob/main/PRIVACY.md` (it exists on `main` once the `redesign` branch is merged; until then use the `redesign` branch link).

## Pre-flight checklist (do in this order)
1. Developer Dashboard: one-time fee paid, trader declaration = **non-trader** (free personal project; no contact details are shown on the listing), contact email verified. If Debrief ever becomes a paid or company product, change this to trader first.
2. `npm test` and the three Chrome tests pass; bump the version (docs/VERSIONING.md) and add a CHANGELOG line.
3. `npm run pack` -> `release/<date>/Debrief-store-v<version>.zip` (no dev `key`). Upload it in the dashboard (Package tab).
4. Store listing tab: name, short and detailed description above, category *Productivity*, language English, icon 128, screenshots `docs/img/store-1..4` (1280x800), optional small promo tile 440x280.
5. Privacy tab: single purpose, each permission justification above, remote code = No, data-use answers above, privacy policy URL.
6. Distribution tab: visibility **Unlisted** first (share the link), regions all or chosen, pricing free.
7. Submit for review. Sensitive permissions (tab capture, access to all sites) mean a longer first review; do not change the package while it is pending.
8. After approval: the store assigns the extension ID. The local helpers (`local/whisper_server.py` CORS regex, `OLLAMA_ORIGINS` in `local/start-local.ps1`) only know the dev ID; update both to the store ID, or upload the public key in the Package tab to keep the dev ID.

## Assets
- Icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800: `docs/img/store-*.png`, generated by `node scripts/screenshots.mjs` (made-up data, no real meetings)
