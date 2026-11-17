# Debrief privacy policy

_Last updated 2026-11-16 (version 1.4.0)._

Debrief is a Chrome extension that records the audio of a meeting tab you choose and turns it into a transcript and minutes of meeting.

**We run no server and receive none of your data.** Everything below happens in your browser or goes straight from your browser to a service you picked.

## What Debrief handles
- **Audio** of the tab you record, and of your microphone if you allow it.
- **Transcripts and minutes** made from that audio, the meeting title, time and the people listed in the call (from Google Meet's page).
- **Your settings** and **your own API keys** for the services you choose.
- **The recording itself**, only if you switch on *Keep the recording*: compressed audio kept on your computer for the number of days you choose, so you can play a line back. It stays on your computer unless you use *Read this part again*, which sends that stretch to your speech-to-text service. Recordings already kept stay until they expire or you delete them, even after you switch the setting off.
- **Pictures of the meeting tab**, only if you switch on *Describe what is shown on the shared screen*: one still picture of the whole meeting tab as you see it (the shared screen, and anything else visible in the tab, such as participant tiles or the chat panel), sent to the service that writes your minutes, which returns a short description. On Google Meet Debrief only looks while someone is presenting; on other meeting apps it cannot tell, so it looks whenever the picture changes. The picture is not kept; the description is.
- **Voice fingerprints** (numbers describing a voice, used to put names on speakers) and, only if you switch it on, short voice clips.

## Where it goes
- Audio or text is sent **only** to the speech-to-text or minutes service you select in Settings (Google Gemini, Sarvam, Deepgram, Anthropic Claude, an OpenAI-compatible service, or a local model on your own computer), using **your own key and account**. Those services have their own privacy terms. Google's free Gemini tier may use submitted content to improve Google's products; use a paid key or a local model for confidential meetings.
- If you turn on email, the minutes are sent through an Apps Script web app that **you** deploy in **your** Google account.
- If you set a **webhook address**, the minutes (title, attendee names, decisions, actions and the minutes text; never the transcript, not even the short quotes the minutes page shows as sources, and no email addresses) are posted to that address when they are written, and only if you gave Chrome's permission for that address.
- If you switch on the **recording notice**, Debrief posts one line of text you chose in the meeting's chat, where everyone in the call can read it.
- **Check model names** asks the service you use for its list of models, with your key.
- A **backup file** you download contains your meetings and settings (your keys only if you tick that box). Where you keep it is up to you. Restoring a file never changes where your data goes (servers, sharing, the webhook, the email relay, the chat notice) unless you tick each of those changes, and a key you have is never sent to a server address that came from a file.
- Nothing else leaves your computer. No analytics, no advertising, no tracking, no remote code.

## What stays on your device
Settings, keys, meetings, transcripts, minutes, voice fingerprints and clips are stored in Chrome's local extension storage on your computer. Voice fingerprints and clips are never uploaded.

## Your control
You can delete any meeting, a voice, or all voice data in the extension at any time, discard a recording you started by mistake, and remove everything by uninstalling the extension.

## What we do not do
We do not sell or share your data, use it for advertising or credit decisions, or read it. We cannot: we never receive it.

## Recording people
Tell people before you record them. The laws on recording differ by country and by workplace; that responsibility is yours.

## Contact
Questions: open an issue at https://github.com/devshrawin/Debrief/issues
