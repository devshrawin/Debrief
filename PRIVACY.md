# Debrief privacy policy

_Last updated 2026-10-24 (version 0.2.0)._

Debrief is a Chrome extension that records the audio of a meeting tab you choose and turns it into a transcript and minutes of meeting.

**We run no server and receive none of your data.** Everything below happens in your browser or goes straight from your browser to a service you picked.

## What Debrief handles
- **Audio** of the tab you record, and of your microphone if you allow it.
- **Transcripts and minutes** made from that audio, the meeting title, time and the people listed in the call (from Google Meet's page).
- **Your settings** and **your own API keys** for the services you choose.
- **Voice fingerprints** (numbers describing a voice, used to put names on speakers) and, only if you switch it on, short voice clips.

## Where it goes
- Audio or text is sent **only** to the speech-to-text or minutes service you select in Settings (Google Gemini, Sarvam, Deepgram, Anthropic Claude, an OpenAI-compatible service, or a local model on your own computer), using **your own key and account**. Those services have their own privacy terms. Google's free Gemini tier may use submitted content to improve Google's products; use a paid key or a local model for confidential meetings.
- If you turn on email, the minutes are sent through an Apps Script web app that **you** deploy in **your** Google account.
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
