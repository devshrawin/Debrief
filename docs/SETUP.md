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

**The quick way:** when you first install Debrief, a guided tour opens automatically. It walks you through the steps below, tests each one as you go, and teaches how to record, what happens when a meeting ends, and how email and sharing work. If you closed it, reopen it from the popup (**Take the tour**) or from the bottom of the Settings sidebar. The manual steps follow for reference.

Click the Debrief icon, then **Settings** (or right-click the icon → *Options*). The settings page has five sections on the left: **Get started**, **General**, **Speech to text**, **Minutes** and **Email**. *Get started* ticks off each step as you finish it.

1. **Get started:** paste the key into **API key** under *Google Gemini*.
2. **General → Profile:** type your **name**. Lines from your own microphone are tagged with it.
3. **General → Microphone:** click **Allow microphone** and choose *Allow*. This lets Debrief include your own voice. Skip it if you only want other people's audio.
4. **General → Language:** pick the **Language spoken in meetings**:
   - *Auto*: Hindi, English and Malayalam in any mix (default).
   - *Hindi + English*: Hinglish meetings.
   - *Malayalam + English*: Manglish meetings.
5. Choose the **Language of the minutes** (English, Hindi or Malayalam).
6. Press **Save changes**. Then open **Minutes** and press **Test connection**. You should see `works ✓`.

## 4. Record a meeting

1. Open your Google Meet and join the call.
2. Click the Debrief icon, then **Start recording this tab** (or press `Alt+Shift+M`). The icon shows a red **REC** badge.
3. Talk as usual. In the popup, the **meeting audio** bar should move when others speak. The first transcript segment appears after about 2 to 3 minutes.
4. **Your microphone:** use the switch in the popup, or press `Alt+Shift+K`, to include or ignore your voice at any time. Debrief also ignores your mic automatically while *you are muted in Meet*.
5. When the meeting ends, Debrief stops by itself: it notices Meet's *"You left the meeting"* or *"The meeting has ended"* screen, or that you left the call page, and opens the minutes in a background tab. (Turn this off, or change the silence safety net, under **Settings → General → Recording**.) You can also click **Stop & write MOM** yourself at any time. The minutes page opens and the minutes are written for you. You can edit them, copy them, or save as Markdown, Word or PDF.

Good practice: tell participants you are recording, and use headphones so your mic doesn't pick up the speakers.

## 5. Email the minutes to yourself (optional)

Debrief can email you the minutes as soon as they are ready. It uses a small script in **your own Google account**, so the email comes from you. Setup is one copy, one paste, one URL.

1. In Debrief open **Settings → Email** and press **Copy the script** (inside *How to set it up*).
2. Go to <https://script.google.com/home/start> and sign in. Click **New project**. Click inside the code box, press `Ctrl+A` to select everything, then `Ctrl+V` to paste. Press `Ctrl+S` to save.
3. Click the blue **Deploy** button (top right) → **New deployment**.
4. Next to *Select type* click the gear and choose **Web app**.
5. Set **Who has access** to **Anyone**. Leave *Execute as* on *Me*. Click **Deploy**.
6. Google asks you to **Authorize access**. Choose your account. If it warns *"Google hasn't verified this app"*, click **Advanced → Go to … (unsafe)** and then **Allow**. It's your own script.
7. Copy the **Web app URL** (it ends in `/exec`).
8. Back in Debrief paste it into **Apps Script web app URL**, tick the attachments you want, press **Save**, then **Send test email**. It should arrive within a minute.

> Is "Anyone" safe? The script can only email **you** (plus any addresses you add to `ALLOWED` at the top of the script), whatever a request says, and it locks itself to your Debrief on first use: Debrief makes up a random secret by itself (you never type or see it) and the script refuses requests without it. So the web address alone is not enough for anyone else. If you ever reinstall Debrief or move to another browser profile and the test email says the script is *locked*, open the script, choose the function **resetSecret**, press **Run** once, and send the test email again.

**What can be attached** (the email itself always contains the full minutes):

| Option | What you get |
|---|---|
| **MOM as PDF** | A formatted A4 PDF (default on) |
| **MOM as Word (.doc)** | Opens in Word with tables intact |
| **MOM as Markdown (.md)** | Plain text with formatting marks |
| **Transcript (.txt)** | The full transcript |

**Day to day**
- After a meeting, leave the minutes tab open until it says **Emailed to … ✓**.
- Regenerating or editing the minutes never re-sends by itself. Press **Email me** on the minutes page to send again.
- Limit: about 100 emails per day for a normal Gmail account.

**If you change the script later:** press **Deploy → Manage deployments → pencil → Version: New version → Deploy**. Saving alone doesn't update the live copy.

### Sharing the minutes with your team (optional)
1. **Settings → Email → Sharing with others**: list the people (a default list, and a list per recurring meeting, matched by words in the title).
2. Press **Copy script with these people allowed**, paste it over your script at script.google.com, save, and **Deploy → Manage deployments → pencil → Version: New version → Deploy**. The script only ever emails you plus the people you allow. Tick *Allow everyone at their company* to allow whole domains instead of single addresses.
3. After a meeting you receive the email. Open the minutes page, check names and numbers, and press **Share** under *Share these minutes with others*. Choose *Send to them automatically* in Settings if you would rather skip the review.

### Who was invited vs who attended (optional)
Debrief can read each meeting's invite from your Google Calendar through the same script and compare it with the people seen in the call.
1. In script.google.com open your script, choose the **`authorize`** function in the toolbar and press **Run** once. Allow access to your calendar and email.
2. Deploy a **new version** if you changed the script.
3. Keep *Look up who was invited* on in **Settings → Email → Calendar**.

The minutes then include an attendance table, and the attendee list on the minutes page is filled in for you.

The table lists every invitee with their reply, whether they were seen in the call (**Yes** or **Absent**), when they joined and left, plus anyone seen who was not invited. Debrief finds the calendar event by its Meet link, then by its exact title, then by a similar title (Meet links added with "Add Google Meet" are often not stored in the event text). The script must be **version 7 or newer**: copy the script again from Settings → Email and deploy a **new version** (Deploy → Manage deployments → pencil → New version). If no event can be found, the minutes say why instead of guessing. "Absent" means not seen: attendance is read from the video tiles on the call page, plus speech and captions when those are on, so someone who joined without being on screen can be shown as absent.

### Who is speaking: voice recognition (optional)
Names the speakers in the transcript and minutes by their voice. It is a best guess, off by default, and everything happens in your browser.
1. Open **Settings → Voices** and click **Allow microphone** on the General page if Chrome has not asked yet.
2. Under **Add a person** type the name, choose the language they use in meetings (English, Hindi, Malayalam or *Speak freely* for anything else), press **Record** and read the text for about 20 seconds in a quiet room. The meter should move. Play it back. Press **Save this voice**. Only a fingerprint (256 numbers) is stored, never the recording.
3. Do the same for each regular colleague, ideally recorded on their own computer and microphone. For someone who uses two languages, press **Add recording** and record the other one. **Re-record** replaces a voice.
4. Turn on **Name speakers by their voice** and press **Save changes**. Record your next meeting as usual; the names appear on the minutes page, in the downloaded and emailed transcript, in the minutes, and in the attendance table.
5. **Learn on its own (optional):** turn on *Learn who is who from my meetings*. No captions or particular language needed: voices that keep coming back are listed as *Unnamed voice 1, 2…* after a recording stops. Rename one (check the transcript at its times) and it is named from then on. If Meet's captions are on and name a single speaker, Debrief uses that to name the voice for you. A learned voice is used only after about 45 seconds of clean speech from two meetings. Voices from your latest meeting that match nobody also appear under *Unnamed voices in your latest meeting*, where you can name them straight away.
6. **Share with a colleague:** *Export voices* gives a `.json` file; they use *Import voices*. Only share fingerprints of people who have agreed.
7. **Hear who an unnamed voice is:** *Keep short samples of unnamed voices* is on by default whenever learning is on (switch it off in Settings → Voices if people on your calls have not agreed). After the next recording, *Unnamed voice N* gets a **▶ Play sample** button with about 8 seconds of that voice. The clip is deleted when you name the voice, delete it, or forget all voices. This is the only audio Debrief keeps for voice recognition; leave it off if people on your calls have not agreed.
8. **A meeting in a room, or only you (optional):** use the **Online meeting / In a room** switch in the popup before you press Start. It is already set by the tab's link (a meeting link means online, any other tab means a room). In a room your microphone is treated as the meeting: its lines say "Room" or the person's name once you have named the voices, your mic is not paused when Meet shows you muted, and the minutes writer is told several people share it. Open any normal web page tab (not a Chrome settings page), press Start recording, and speak. Accuracy drops with distance from the microphone, echo and overlapping speech.
9. **Forget all voices** deletes every fingerprint and clip, including fingerprints saved inside past meetings.

What to expect: names are right most of the time for clear speech and wrong or *Unknown speaker* when people overlap, speak briefly or sound alike. Where Meet's captions disagree, both names are shown. Check by listening before relying on a name. Privacy and limits are in the README under *Voice recognition*.

## 6. Other speech providers (optional)

| Provider | When to use it | Setup |
|---|---|---|
| **Sarvam AI** | Best accuracy for Hinglish and Malayalam | Get a key at <https://dashboard.sarvam.ai>, choose *Sarvam* under Speech-to-text, paste the key |
| **Deepgram** | Hindi and English only (no Malayalam) | Key from <https://console.deepgram.com> |
| **Whisper-compatible** | Groq, OpenAI or a local server | Enter the base URL, key and model. Custom URLs ask for a permission once |

For the minutes you can also pick **Claude** (Anthropic key) or any **OpenAI-compatible** model under *MOM writer*.

## Minutes format (official Amnex template)

By default Debrief fills the Amnex house template (header block, Client / System Integrator attendee tables, numbered discussion and action items, Next Meeting). To get the attendee sides and honorifics right:

1. Open **Settings > Minutes > Minutes format**.
2. Put your company email domain(s) in **Our email domains**, for example `amnex.com`. Leave it blank to use the domain of your "Send to" address.
3. Optionally fill the **People directory**, one person per line: `Name | Honorific | Department | Designation | Organisation`. Add `| Chair` at the end for the usual chairperson. People who are not listed show `[DESIGNATION]` / `[DEPARTMENT]` / `[CLIENT]` placeholders to fill in by hand.
4. To name the chair for one meeting, write `Chairperson: Name` in the context box on the minutes page before pressing Generate.
5. Choose **Debrief standard** instead if you want the older free-form minutes.

For a PDF with page numbers use **Print / PDF** on the minutes page (Chrome 131 or newer) and choose *Save as PDF*. The PDF attached to the email is built by your Apps Script and has no page numbers.

## 7. Troubleshooting

| What you see | What to do |
|---|---|
| Red **API limit reached** | A free daily quota is used up. Debrief tries other models and keeps any audio it couldn't transcribe. Wait for the reset, add a second key from a **different** Google project, or enable billing |
| Red **API key rejected** | The key is wrong or lacks access. Paste it again in Settings |
| Meeting audio bar says **silent** | The Meet tab is muted or nobody is talking |
| **No audio data arriving** | Stop and start the recording again |
| Mic bar says **silent** | Wrong input device, or you are muted in Meet |
| Test email: *"locked to a different Debrief install"* | You reinstalled Debrief or use a new browser profile. In the script editor choose **resetSecret**, press **Run** once, then send the test email again |
| Test email: *"asked for a Google sign-in"* | The web app is not set to **Who has access: Anyone**. Deploy again with that setting |
| Test email works but the PDF is missing | Tick **MOM as PDF** and press Save. If you changed the script, deploy a new version |
| Test email: *"Could not reach the mail relay"* | The URL is wrong. It must end in `/exec` |
| Nothing happens after installing | Reload your Meet tab once so the extension attaches to it |
| Errors "Extension context invalidated" in `chrome://extensions` | Harmless. Appears when the extension is reloaded while a Meet tab is open. Reload the tab and press **Clear all** |

Still stuck? Open an issue at <https://github.com/devshrawin/Debrief/issues> and include the text of any red banner.
