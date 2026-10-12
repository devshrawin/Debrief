# Debrief setup guide

Everything you need to go from zero to "minutes land in my inbox". About 10 minutes the first time, most of it optional. No coding needed apart from copy and paste.

**Contents**
1. [Install the extension](#1-install-the-extension)
2. [Get a free Gemini API key](#2-get-a-free-gemini-api-key)
3. [Configure Debrief](#3-configure-debrief)
4. [Record a meeting](#4-record-a-meeting)
5. [Email the minutes to yourself (optional)](#5-email-the-minutes-to-yourself-optional)
6. [Other speech providers (optional)](#6-other-speech-providers-optional)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Install the extension

You need **Google Chrome 116 or newer** and [Node.js](https://nodejs.org) (only used once, to prepare the files).

1. Download the project: on the GitHub page click **Code → Download ZIP** and unzip it, or run `git clone https://github.com/devshrawin/Debrief.git`.
2. Open a terminal in that folder and run:
   ```bash
   npm install
   npm run build
   ```
3. In Chrome open `chrome://extensions`.
4. Switch on **Developer mode** (top right).
5. Click **Load unpacked** and choose the **`extension`** folder inside the project.
6. Click the puzzle-piece icon in Chrome's toolbar and **pin Debrief** so the icon is always visible.

> The prebuilt files are already in the repository, so if you cannot install Node.js you can skip the two `npm` commands and load the `extension` folder as it is.

## 2. Get a free Gemini API key

Debrief uses Google Gemini to turn speech into text and to write the minutes. The free tier is enough for normal use.

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key**. Choose any project (or let it create one).
3. Copy the key. It starts with `AIza` or `AQ.`.

**Optional second key.** Free-tier limits are counted per Google Cloud project, so a second key only helps if it comes from a **different project**. Create a second project in the Google Cloud console, then another key. Debrief switches to it automatically when the first runs out.

**Privacy note.** On Google's free tier, audio and transcripts may be used to improve Google's products and may be read by human reviewers. For confidential meetings enable billing on the key (paid-tier terms are stricter) or use a different provider.

## 3. Configure Debrief

Click the Debrief icon, then **Settings** (or right-click the icon → *Options*). A *Get started* card at the top ticks off each step as you finish it.

1. Paste the key into **Gemini API key**.
2. Type your **name**. Lines from your own microphone are tagged with it.
3. Click **Grant microphone** and choose *Allow*. This lets Debrief include your own voice. Skip it if you only want other people's audio.
4. Pick the **Meeting language**:
   - *Auto*: Hindi, English and Malayalam in any mix (default).
   - *Hindi + English*: Hinglish meetings.
   - *Malayalam + English*: Manglish meetings.
5. Choose the language the minutes should be **written in** (English, Hindi or Malayalam).
6. Press **Save**, then **Test LLM**. You should see `works ✓`.

## 4. Record a meeting

1. Open your Google Meet and join the call.
2. Click the Debrief icon, then **Start recording this tab** (or press `Alt+Shift+M`). The icon shows a red **REC** badge.
3. Talk as usual. In the popup, the **meeting audio** bar should move when others speak. The first transcript segment appears after about 2 to 3 minutes.
4. **Your microphone:** use the switch in the popup, or press `Alt+Shift+K`, to include or ignore your voice at any time. Debrief also ignores your mic automatically while *you are muted in Meet*.
5. When the meeting ends click **Stop & write MOM**. The minutes page opens and the minutes are written for you. You can edit them, copy them, or save as Markdown, Word or PDF.

Good practice: tell participants you are recording, and use headphones so your mic doesn't pick up the speakers.

## 5. Email the minutes to yourself (optional)

Debrief can email the minutes the moment they are ready. It does this through a tiny script that runs **inside your own Google account**, so the email comes from you and no other server is involved. You do this setup once.

### 5.1 Create the relay script
1. Open <https://script.google.com/home/start> and sign in with the Google account that should send the email.
2. Click **New project**.
3. Delete everything in the editor.
4. Open the file [`apps-script/Code.gs`](../apps-script/Code.gs) from this project (or press **Copy the script** in Debrief's Settings → *Email the MOM*) and paste it into the editor.
5. Near the top, change `const TOKEN = 'CHANGE-ME';` to a long random string, for example `const TOKEN = 'k7Qp-2vXr9-LmT4-8aZw';`. This is your password for the relay. Keep it.
6. Click the disk icon to **Save**.

### 5.2 Publish it
1. Click **Deploy → New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**.
4. Click **Deploy**.
5. Click **Authorize access**, choose your account, and approve. If Google says *"Google hasn't verified this app"*, click **Advanced → Go to (project name)**. It's your own script.
6. Copy the **Web app URL**. It ends in `/exec`.

> *"Anyone"* sounds scary but the script rejects every request that does not carry your token, and it only ever emails **your own address** plus anything you list in its `ALLOWED` setting.

### 5.3 Connect Debrief
1. Open Debrief **Settings → Email the MOM**.
2. Paste the **Web app URL** and your **Token**.
3. Leave **Send to** empty to email yourself, or enter an address you added to `ALLOWED` in the script.
4. Tick what you want attached. The email body always contains the full minutes.

   | Option | What you get |
   |---|---|
   | **MOM as PDF** | A formatted A4 PDF (default on) |
   | **MOM as Word (.doc)** | Opens in Word with tables intact |
   | **MOM as Markdown (.md)** | Plain text with formatting marks |
   | **Transcript (.txt)** | The full transcript |

5. Keep **Email the MOM automatically** ticked to send as soon as the minutes are written.
6. Press **Save**, then **Send test email**. It should arrive within a minute. If it doesn't, see [troubleshooting](#7-troubleshooting).

### 5.4 Day to day
- After a meeting, leave the minutes tab open until it says **Emailed to … ✓**.
- Regenerating or editing the minutes never re-sends by itself. Press **Email me** on the minutes page to send again.
- Sending limits: about 100 emails per day for a normal Gmail account.

## 6. Other speech providers (optional)

| Provider | When to use it | Setup |
|---|---|---|
| **Sarvam AI** | Best accuracy for Hinglish and Malayalam | Get a key at <https://dashboard.sarvam.ai>, choose *Sarvam* under Speech-to-text, paste the key |
| **Deepgram** | Hindi and English only (no Malayalam) | Key from <https://console.deepgram.com> |
| **Whisper-compatible** | Groq, OpenAI or a local server | Enter the base URL, key and model. Custom URLs ask for a permission once |

For the minutes you can also pick **Claude** (Anthropic key) or any **OpenAI-compatible** model under *MOM writer*.

## 7. Troubleshooting

| What you see | What to do |
|---|---|
| Red **API limit reached** | A free daily quota is used up. Debrief tries other models and keeps any audio it couldn't transcribe. Wait for the reset, add a second key from a **different** Google project, or enable billing |
| Red **API key rejected** | The key is wrong or lacks access. Paste it again in Settings |
| Meeting audio bar says **silent** | The Meet tab is muted or nobody is talking |
| **No audio data arriving** | Stop and start the recording again |
| Mic bar says **silent** | Wrong input device, or you are muted in Meet |
| Test email: *"Token does not match"* | The token in Settings differs from `TOKEN` in the script. Paste exactly the same value, then **redeploy** (Deploy → Manage deployments → pencil → *New version*) |
| Test email: *"asked for a Google sign-in"* | Redeploy with **Who has access: Anyone** |
| Test email: *"Could not reach the mail relay"* | The URL is wrong. It must end in `/exec` |
| PDF missing from the email | Tick **MOM as PDF** and save. The script needs the *Authorize access* step to have been completed |
| Nothing happens after installing | Reload your Meet tab once so the extension attaches to it |
| Errors "Extension context invalidated" in `chrome://extensions` | Harmless. Appears when the extension is reloaded while a Meet tab is open. Reload the tab and press **Clear all** |

Still stuck? Open an issue at <https://github.com/devshrawin/Debrief/issues> and include the text of any red banner.
