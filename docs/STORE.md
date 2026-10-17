# Chrome Web Store listing

Source: docs/redesign/Brand.dc.html.

## Short description (115 of 132 characters)

Records your Meet, Zoom or Teams tab and writes the minutes, in English, Hindi and Malayalam. Speaker names and who joined come from Google Meet only; on other apps it records the audio. Keys stay in your browser.

## Long description

Debrief records the audio of the meeting tab you choose, transcribes it, and writes the Minutes of Meeting while the call is still fresh: decisions, action items with owners and dates, and who was there.

What it does
- Records a Google Meet, Zoom or Teams tab. One click, or Alt+Shift+M. (Speaker names, captions and attendance: Google Meet only. Other apps: audio recording, with best-effort mute follow and end-of-call.)
- Transcribes English, Hindi, Malayalam and mixed speech such as Hinglish.
- Writes the minutes when the meeting ends: decisions, action items, attendance.
- Edit the minutes, share them, or email them to the people who were invited.
- Learns the names and voices you teach it, so people are called what you call them.
- Ask a question about one meeting, or about all of them.

Your data
- Your own API keys stay in your browser. Debrief has no server of its own.
- Audio is sent only to the transcription service you pick.
- Optional voice samples are off by default and deleted when you name, delete or forget a voice.

The icon tells you what is going on: a saffron glow when a call is on and Debrief is idle, a red REC badge while recording, and a dark "!" badge when something needs attention (a rejected key, a quota hit, a silent microphone).

You bring the transcription and writing keys (a free Gemini key is enough to start). Debrief tells you plainly what each one is used for.

## Toolbar icon states and tooltips

| State | Icon | Tooltip |
| --- | --- | --- |
| Idle | plain mark | Debrief |
| Call on, not recording | glow variant swapped with the plain one every 600 ms | A call is on. Click to record. |
| Recording | red REC badge, never animated | Recording · 12:48 (live) |
| Needs attention | dark "!" badge | Debrief needs attention |

## Screenshots (5 at 1280 x 800)

One claim per screenshot, set in large type on the left (360 of 960 px, indigo #2c268a field, white Debrief mark); the real product UI on the right, never mocked browser chrome.

1. **Your meeting ends. The minutes are already written.** The minutes page: Emailed chip, decisions, action-items table (including a Malayalam row). Subtitle: Decisions, action items with owners and dates, and who was there. Edit, share or email in one click.
2. **One click to record any call.** The popup on a Meet tab, Record tab, with the glowing toolbar icon visible.
3. **Hindi, English and Malayalam in one meeting.** The transcript with mixed-language lines and speaker names.
4. **Ask about your meetings.** The Ask page answering a question with the meeting it came from.
5. **Your keys, your browser.** The settings page showing provider keys and the privacy toggles.

## Store package and the extension ID

`npm run pack` writes `release/Debrief-Pro-v<version>.zip` from a copy of `extension/` whose manifest has **no `key` field** (the Web Store assigns the ID itself; the dev manifest keeps the key so the ID stays `nckojmcchehoejdfklcmllhpekagiddo` for local testing). I could not confirm from Google's current docs whether an uploaded `key` is rejected or ignored, so the store package leaves it out.

Consequence: the store-installed extension gets a different ID, and the local helpers only accept the dev ID (`local/whisper_server.py` CORS regex, `OLLAMA_ORIGINS` in `local/start-local.ps1`). Before publishing, either upload your public key in the Developer Dashboard (Package tab) so the ID stays the same, or update those two places to the store ID.
