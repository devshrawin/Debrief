// First-run tour: teaches Debrief step by step, saves each answer, and tests the pieces that can be tested
// (the Gemini key, the microphone, the email relay) so the user finds out now, not in the middle of a meeting.
import { getSettings, saveSettings, DEFAULTS } from './store.js';
import { generate } from './llm.js';
import { sendMail, mailReady, scriptWithAllowList, parseAddresses } from './mailer.js';
import scriptText from '../apps-script/Code.gs';

const GUIDE = 'https://github.com/devshrawin/Debrief/blob/pro/docs/SETUP.md';
const LOCAL_GUIDE = 'https://github.com/devshrawin/Debrief/blob/pro/docs/LOCAL.md';

let S = { ...DEFAULTS };
let tour = { step: 0, visited: [], keyOk: false };
let micOk = false;
let shortcuts = {};

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const card = (title, ...kids) => h('div', { class: 'card' }, title ? h('h2', {}, title) : null, ...kids);
const p = (text, cls) => h('p', { class: cls || '' }, text);
const kbd = (t) => h('kbd', {}, t);
const status = () => h('span', { class: 'status' });
const say = (el, text, kind) => {
  el.textContent = text;
  el.className = `status ${kind || ''}`;
};

async function patch(obj) {
  S = { ...S, ...obj };
  const { shareAutoFlag, ...clean } = S; // shareAutoFlag is only a view of shareMode
  await saveSettings(clean);
}
async function saveTour() {
  await chrome.storage.local.set({ tour });
}

// A switch row bound to a setting.
function toggle(key, title, sub, { invert = false, onChange } = {}) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = invert ? !S[key] : !!S[key];
  cb.onchange = async () => {
    if (key === 'shareAutoFlag') S.shareAutoFlag = cb.checked;
    else await patch({ [key]: invert ? !cb.checked : cb.checked });
    onChange?.(cb.checked);
  };
  return h('label', { class: 'toggle' }, h('span', { class: 't' }, h('b', {}, title), h('span', {}, sub)), cb);
}
function field(label, id, value, { type = 'text', placeholder = '', area = false } = {}) {
  const el = area ? h('textarea', { id, placeholder }) : h('input', { id, type, placeholder, autocomplete: 'off' });
  el.value = value || '';
  return [h('label', { for: id }, label), el];
}

// ------------------------------------------------------------------------------------------------
// Steps. Each returns { title, lede, kicker, optional, nodes(), save?() }
// ------------------------------------------------------------------------------------------------
const STEPS = [
  {
    id: 'welcome',
    label: 'Welcome',
    kicker: 'Welcome',
    title: 'Meeting minutes without taking notes',
    lede: 'This takes about five minutes. Every step can be skipped and redone later in Settings, and each one is tested so you know it works before your first real meeting.',
    nodes: () => [
      card('How Debrief works',
        h('ol', { class: 'how' },
          h('li', {}, 'You join a Google Meet as you always do.'),
          h('li', {}, 'You start Debrief. It records the sound of that browser tab (the other people) and, if you want, your own microphone.'),
          h('li', {}, 'It turns the speech into text, in Hindi, English, Malayalam or any mix of them.'),
          h('li', {}, 'When the call ends, Debrief stops by itself, writes the minutes with decisions and action items, and can email them to you and your team.'))),
      h('div', { class: 'grid2' },
        h('div', { class: 'mini' }, h('b', {}, 'What you need'), 'One free Gemini key (two minutes). Everything else is optional: microphone, names, email, sharing.'),
        h('div', { class: 'mini' }, h('b', {}, 'Your privacy'), 'There is no Debrief server. Audio and text go directly from your browser to the service you choose, and your keys never leave this browser.')),
      h('div', { class: 'callout', style: 'margin-top:16px' }, 'Tell participants when you are recording. Your company may also restrict browser extensions or tab capture.'),
    ],
  },
  {
    id: 'key',
    label: 'Gemini key',
    kicker: 'Step 1',
    title: 'Add your free Gemini key',
    lede: 'Gemini turns the speech into text and writes the minutes. Google gives you a free key; no card is needed.',
    nodes: () => {
      const st = status();
      const test = h('button', { class: 'btn primary', onclick: async () => {
        const key = $('t-key').value.trim();
        if (!key) return say(st, 'Paste your key first.', 'bad');
        say(st, 'Testing…');
        await patch({ geminiKey: key, geminiKey2: $('t-key2').value.trim() });
        try {
          const out = await generate({ settings: { ...S, llmProvider: 'gemini' }, system: 'You are a connectivity test.', user: 'Reply with exactly: OK', onText: () => {} });
          tour.keyOk = true;
          await saveTour();
          say(st, `Your key works ✓ (it answered "${out.trim().slice(0, 12)}")`, 'ok');
        } catch (e) {
          say(st, `That did not work: ${e.message.slice(0, 160)}`, 'bad');
        }
      } }, 'Test my key');
      return [
        card('Get a key (2 minutes)',
          h('ol', { class: 'how' },
            h('li', {}, 'Open ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank' }, 'aistudio.google.com/apikey'), ' and sign in with a Google account.'),
            h('li', {}, 'Click ', h('b', {}, 'Create API key'), ' and copy it.'),
            h('li', {}, 'Paste it below and press ', h('b', {}, 'Test my key'), '.')),
          ...field('Gemini API key', 't-key', S.geminiKey, { type: 'password', placeholder: 'Paste your key here' }),
          h('div', { class: 'btnrow' }, test, st)),
        card('Good to know',
          p('The free tier has daily limits per model, so very long or many meetings in one day can hit them. Debrief switches to other models automatically, keeps any audio it could not process, and shows a red alert if a limit stops it.'),
          p('On the free tier Google may use what you send to improve its products and reviewers may read it. For confidential meetings, turn on billing for the key or pick another provider in Settings.', 'hint'),
          ...field('Backup key (optional)', 't-key2', S.geminiKey2, { type: 'password', placeholder: 'A key from a different Google Cloud project' }),
          p('Limits count per project, so a backup only helps if it comes from a different project.', 'hint')),
      ];
    },
    save: async () => patch({ geminiKey: $('t-key').value.trim(), geminiKey2: $('t-key2').value.trim() }),
  },
  {
    id: 'mic',
    label: 'Microphone',
    kicker: 'Step 2',
    title: 'Your microphone',
    lede: 'Debrief always records the other people from the tab. To include your own voice it also needs your microphone.',
    optional: true,
    nodes: () => {
      const st = status();
      if (micOk) say(st, 'Microphone allowed ✓', 'ok');
      return [
        card('Allow the microphone',
          p('Chrome asks once. Press the button and choose Allow.'),
          h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach((t) => t.stop());
              micOk = true;
              say(st, 'Microphone allowed ✓', 'ok');
            } catch (e) {
              say(st, `Not allowed: ${e.message}. You can allow it later from the lock icon in the address bar or in Settings.`, 'bad');
            }
          } }, 'Allow microphone'), st)),
        card('How your voice is handled',
          toggle('captureMic', 'Include my microphone', 'Your own voice goes into the transcript, labelled with your name.'),
          toggle('followMeetMute', 'Pause my mic while muted in Meet', 'Muting yourself in Google Meet does not mute Debrief by itself, so this makes Debrief follow your Meet mute button. Side conversations stay out of the transcript.'),
          p('You can also switch your voice in or out at any time from the popup or with the keyboard.', 'hint')),
      ];
    },
  },
  {
    id: 'you',
    label: 'You and language',
    kicker: 'Step 3',
    title: 'Your name and languages',
    lede: 'Your name labels your lines in the transcript. The languages tune the speech recognition.',
    nodes: () => [
      card('',
        ...field('Your name', 't-name', S.myName, { placeholder: 'e.g. Shrawin Sisodiya' }),
        h('label', { for: 't-lang' }, 'Language spoken in your meetings'),
        h('select', { id: 't-lang' },
          h('option', { value: 'auto' }, 'Automatic: Hindi, English and Malayalam, in any mix'),
          h('option', { value: 'hinglish' }, 'Hindi and English (Hinglish)'),
          h('option', { value: 'malayalam' }, 'Malayalam and English (Manglish)')),
        h('label', { for: 't-mom' }, 'Language of the written minutes'),
        h('select', { id: 't-mom' },
          h('option', {}, 'English'),
          h('option', {}, 'Hindi (Devanagari)'),
          h('option', {}, 'Malayalam'),
          h('option', { value: 'the same language mix used in the meeting' }, 'Same as the meeting'))),
    ],
    after: () => {
      $('t-lang').value = S.meetingLanguage;
      $('t-mom').value = S.momLanguage;
    },
    save: async () => patch({ myName: $('t-name').value.trim(), meetingLanguage: $('t-lang').value, momLanguage: $('t-mom').value }),
  },
  {
    id: 'names',
    label: 'Names and terms',
    kicker: 'Step 4',
    title: 'Teach Debrief your names',
    lede: 'Speech recognition guesses unusual names and local terms: "Amal" often comes out as "Aman". A short dictionary fixes this for good.',
    optional: true,
    nodes: () => [
      card('Your dictionary',
        p('One entry per line. Write the correct spelling, then a bar, then the wrong versions Debrief tends to produce. A line with only a name or term is just a spelling hint.'),
        ...field('', 't-dict', S.dictionary, { area: true, placeholder: 'Amal | Aman, Amaal\nPriya Nair\nUnified Registry\nDSM' }),
        p('Used as a hint to the speech model, as an automatic correction of the transcript, and by the minutes writer.', 'hint')),
      card('Two more tools you will meet later',
        h('ol', { class: 'how' },
          h('li', {}, h('b', {}, 'Who was in the meeting'), ': on each minutes page you can list the attendees. Then "Aman" is corrected to "Amal" only if Amal is there and Aman is not.'),
          h('li', {}, h('b', {}, 'Fix a name everywhere'), ': spot a wrong name in the minutes, type the wrong and right spelling once, and it is corrected in the transcript and minutes and remembered for next time.'))),
    ],
    save: async () => patch({ dictionary: $('t-dict').value }),
  },
  {
    id: 'record',
    label: 'Recording',
    kicker: 'Step 5',
    title: 'Recording your first meeting',
    lede: 'Here is exactly what to do in a meeting, and what Debrief does for you.',
    nodes: () => [
      card('In the meeting',
        h('ol', { class: 'how' },
          h('li', {}, 'Join your Google Meet as usual and keep that tab in front.'),
          h('li', {}, 'Click the Debrief icon in the toolbar and press ', h('b', {}, 'Start recording this tab'), ', or just press ', kbd(shortcuts['toggle-recording'] || 'Alt+Shift+M'), '. The icon shows a red REC badge.'),
          h('li', {}, 'Open the popup any time to see two level bars: ', h('b', {}, 'Meeting audio'), ' should move when others speak, and ', h('b', {}, 'Your mic'), ' when you do. If they say "silent", fix the sound before you have lost minutes.'),
          h('li', {}, 'To leave your own voice out for a while, use the switch in the popup or press ', kbd(shortcuts['toggle-mic'] || 'Alt+Shift+K'), '.'),
          h('li', {}, 'When the meeting ends, Debrief stops by itself, opens the minutes in a background tab, and writes them. This takes a minute or two. You can also press ', h('b', {}, 'Stop & write MOM'), ' yourself.'),
          h('li', {}, 'On the minutes page, check names and numbers, list the attendees if you like, then copy, download or share them. Keep the tab open until it says "Emailed ✓" if email is on.'))),
      card('Automatic behaviour',
        toggle('autoStop', 'Stop when the meeting ends', 'Notices Meet\'s "you left" and "meeting ended" screens, or you leaving the call page.'),
        h('label', { for: 't-quiet' }, 'Also stop after silence'),
        h('select', { id: 't-quiet', onchange: (e) => patch({ autoStopQuietMin: Number(e.target.value) }) },
          h('option', { value: '0' }, 'Never'), h('option', { value: '5' }, 'After 5 quiet minutes'), h('option', { value: '10' }, 'After 10 quiet minutes'), h('option', { value: '15' }, 'After 15 quiet minutes'), h('option', { value: '30' }, 'After 30 quiet minutes')),
        p('A safety net for when nobody has made a sound for that long.', 'hint')),
      card('Optional extras on the Meet page',
        toggle('pillOnPage', 'Show a small recording pill on the call', 'A draggable capsule with the timer, a mic switch and alerts. Off by default so nothing covers your meeting.'),
        h('label', { for: 't-cap' }, 'Speaker names from Meet'),
        h('select', { id: 't-cap', onchange: (e) => patch({ meetCaptions: e.target.value }) },
          h('option', { value: 'read' }, 'Use Meet\'s captions when I have them on'),
          h('option', { value: 'auto' }, 'Turn captions on for me while recording'),
          h('option', { value: 'off' }, 'Don\'t read captions')),
        p('Meet\'s live captions say who is speaking, so the minutes can name people. Turning captions on shows subtitles on your screen.', 'hint'),
        p('In the popup, "Check page detection" shows what Debrief can read from your Meet page. Use it once in a call to see that speaker names, attendance and the mute button are recognised.', 'hint')),
    ],
    after: () => {
      $('t-quiet').value = String(S.autoStopQuietMin ?? 10);
      $('t-cap').value = S.meetCaptions || 'read';
    },
  },
  {
    id: 'email',
    label: 'Email the minutes',
    kicker: 'Step 6',
    title: 'Get the minutes by email',
    lede: 'Optional, and worth the two minutes. The minutes arrive in your inbox as soon as they are written, sent from your own Google account through a small script you control. No Debrief server is involved.',
    optional: true,
    nodes: () => {
      const st = status();
      const copyMsg = status();
      return [
        card('Set it up',
          h('ol', { class: 'how' },
            h('li', {}, 'Press ', h('b', {}, 'Copy the script'), ' below.',
              h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: async () => { await navigator.clipboard.writeText(scriptText); say(copyMsg, 'Copied ✓', 'ok'); } }, 'Copy the script'), copyMsg)),
            h('li', {}, 'Open ', h('a', { href: 'https://script.google.com/home/start', target: '_blank' }, 'script.google.com'), ', click ', h('b', {}, 'New project'), ', click in the code box, press ', kbd('Ctrl+A'), ' then ', kbd('Ctrl+V'), ' to replace everything, and save with ', kbd('Ctrl+S'), '.'),
            h('li', {}, 'In the toolbar choose the function ', h('b', {}, 'authorize'), ' and press ', h('b', {}, 'Run'), '. Allow access when Google asks (click ', h('i', {}, 'Advanced → Go to … (unsafe)'), ' if it warns, it is your own script).'),
            h('li', {}, 'Click ', h('b', {}, 'Deploy → New deployment'), ', choose ', h('b', {}, 'Web app'), ', set ', h('b', {}, 'Who has access'), ' to ', h('b', {}, 'Anyone'), ', and click ', h('b', {}, 'Deploy'), '.'),
            h('li', {}, 'Copy the ', h('b', {}, 'Web app URL'), ' (it ends in /exec) and paste it here:'))),
        card('',
          ...field('Web app URL', 't-hook', S.emailWebhook, { placeholder: 'https://script.google.com/macros/s/…/exec' }),
          toggle('emailAuto', 'Send automatically', 'Email the minutes as soon as they are written.'),
          toggle('emailPdf', 'Attach a PDF', 'A formatted A4 copy of the minutes.'),
          toggle('emailWord', 'Attach a Word file', 'Opens in Word with tables intact.'),
          toggle('emailTranscript', 'Attach the transcript', 'The full transcript as a text file.'),
          h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: async () => {
            await patch({ emailWebhook: $('t-hook').value.trim() });
            say(st, 'Sending…');
            try {
              const r = await sendMail({ subject: 'Debrief test email', html: '<p>This is a test from <b>Debrief</b>. Your minutes will arrive like this.</p>', text: 'This is a test from Debrief.', attachments: [] }, S);
              say(st, `Sent to ${r.to} ✓ Check your inbox.`, 'ok');
            } catch (e) {
              say(st, `Failed: ${e.message}`, 'bad');
            }
          } }, 'Send test email'), st)),
      ];
    },
    save: async () => patch({ emailWebhook: $('t-hook')?.value.trim() ?? S.emailWebhook }),
  },
  {
    id: 'share',
    label: 'Share and calendar',
    kicker: 'Step 7',
    title: 'Share with your team',
    lede: 'Optional. Debrief can send the minutes to colleagues and show who was invited versus who actually came.',
    optional: true,
    nodes: () => {
      const msg = status();
      return [
        card('Who should get a copy',
          ...field('Default people', 't-share', S.shareList, { area: true, placeholder: 'priya@company.com, ravi@company.com' }),
          p('You always get the email first. After you check names and numbers on the minutes page, press Share. Prefer it to go out by itself? Turn this on:', 'hint'),
          toggle('shareAutoFlag', 'Send to them automatically', 'They get a copy the moment the minutes are written, without your review.', { onChange: (on) => patch({ shareMode: on ? 'auto' : 'review' }) }),
          p('For a recurring meeting with its own team, add lines like "Cadence Call | a@x.com, b@x.com" later in Settings → Email.', 'hint')),
        card('Allow them in your script',
          p('Your script only mails people you allow, so nobody else can use it to send mail. After you add people, copy the updated script, replace the one at script.google.com, and deploy a new version (Deploy → Manage deployments → pencil → Version: New version → Deploy).'),
          toggle('shareDomains', 'Allow everyone at their company', 'Uses the part after the @, so new colleagues work without editing the script.'),
          h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: async () => {
            await patch({ shareList: $('t-share').value });
            await navigator.clipboard.writeText(scriptWithAllowList(scriptText, parseAddresses($('t-share').value), { domains: S.shareDomains }));
            say(msg, 'Copied the script with these people allowed ✓', 'ok');
          } }, 'Copy script with these people allowed'), msg)),
        card('Invited versus attended',
          toggle('calendarLookup', 'Look up who was invited', 'Reads each meeting\'s invite from your Google Calendar through the same script. Needs the authorize step from the email page to have been run, and a new deployment if you changed the script.'),
          p('The minutes then include an attendance table: who came, who was absent, who joined late or left early, and anyone who was not invited. Who actually attended is read from the people shown in the Meet call.', 'hint')),
      ];
    },
    save: async () => patch({ shareList: $('t-share')?.value ?? S.shareList }),
  },
  {
    id: 'local',
    label: 'Local models',
    kicker: 'Step 8',
    title: 'Keeping everything on your computer',
    lede: 'Optional. If you do not want meeting text to leave your PC, Debrief can use models running locally instead of Gemini.',
    optional: true,
    nodes: () => [
      card('What is possible',
        h('div', { class: 'grid2' },
          h('div', { class: 'mini' }, h('b', {}, 'Writing the minutes'), 'Ollama with Gemma, Qwen, Llama and others. Good for clear English or Hinglish, slower and weaker on long or messy meetings.'),
          h('div', { class: 'mini' }, h('b', {}, 'Speech to text'), 'A local Whisper-style server. Good for English and Hindi; Malayalam needs a Malayalam model.')),
        p('Setup takes a few commands and one Debrief button each. Open Settings → Minutes and press "Use Ollama on this PC", then "Find my installed models".'),
        h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html#minutes', target: '_blank' }, 'Open Minutes settings'), h('a', { class: 'btn', href: LOCAL_GUIDE, target: '_blank' }, 'Read the local models guide'))),
      card('Other meeting apps',
        p('Recording, transcription, minutes and email already work on any web meeting tab, not only Meet. For Teams, Zoom (web), Webex, Whereby and Jitsi you can also switch on mute-following and end-of-call detection in Settings → General → Meeting pages (experimental). Installed desktop apps cannot be recorded by a browser extension.')),
    ],
  },
  {
    id: 'usage',
    label: 'Limits and usage',
    kicker: 'Step 9',
    title: 'Keeping an eye on limits',
    lede: 'Free services have daily limits. Debrief counts what it uses and tells you before and when you hit one.',
    optional: true,
    nodes: () => [
      card('What you will see',
        h('ol', { class: 'how' },
          h('li', {}, h('b', {}, 'A yellow warning in the popup'), ' when a model is at 80% of its daily limit.'),
          h('li', {}, h('b', {}, 'A red alert and a Chrome notification'), ' if a limit or a bad key stops a request. Nothing is lost: audio that could not be transcribed is kept and retried when you open the minutes page.'),
          h('li', {}, h('b', {}, 'The Usage page in Settings'), ' with requests, tokens, audio minutes and the limits Debrief has learned from Google\'s own messages. Days roll over at midnight Pacific time.'))),
      card('', p('Thorough minutes (the default) make a few extra requests per meeting to catch every action item. If you run out of free requests often, switch Settings → Minutes to "Quick".'), h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html#usage', target: '_blank' }, 'Open the Usage page'))),
    ],
  },
  {
    id: 'done',
    label: 'All set',
    kicker: 'Done',
    title: 'You are ready',
    lede: 'Here is where things stand. Anything unticked can be done later in Settings.',
    nodes: () => {
      const item = (ok, title, sub) => h('li', { class: ok ? 'ok' : '' }, h('b', {}, title), h('span', { class: 'sub' }, sub));
      return [
        card('Your setup', h('ul', { class: 'checklist' },
          item(tour.keyOk || !!S.geminiKey, 'Gemini key', tour.keyOk ? 'Tested and working.' : S.geminiKey ? 'Saved (not tested).' : 'Not added yet: you need this to record.'),
          item(micOk, 'Microphone', micOk ? 'Allowed.' : 'Not allowed yet. Only the other participants are recorded.'),
          item(!!S.myName, 'Your name', S.myName || 'Not set.'),
          item(!!S.dictionary.trim(), 'Names and terms', S.dictionary.trim() ? `${S.dictionary.trim().split('\n').length} entries.` : 'Empty. Add your team\'s names later.'),
          item(mailReady(S), 'Email', mailReady(S) ? 'Ready.' : 'Not set up (optional).'),
          item(parseAddresses(S.shareList).length > 0, 'Sharing', parseAddresses(S.shareList).length ? `${parseAddresses(S.shareList).length} people.` : 'No one added (optional).'),
          item(S.autoStop, 'Stops by itself', S.autoStop ? 'On.' : 'Off: stop recordings manually.'))),
        card('Cheat sheet',
          h('div', { class: 'grid2' },
            h('div', { class: 'mini' }, h('b', {}, 'Start or stop'), kbd(shortcuts['toggle-recording'] || 'Alt+Shift+M'), ' or the toolbar icon'),
            h('div', { class: 'mini' }, h('b', {}, 'My voice in or out'), kbd(shortcuts['toggle-mic'] || 'Alt+Shift+K'), ' or the popup switch'),
            h('div', { class: 'mini' }, h('b', {}, 'Past meetings'), 'Popup → Meetings tab'),
            h('div', { class: 'mini' }, h('b', {}, 'Change anything'), 'Popup → Settings')),
          h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html', target: '_blank' }, 'Open Settings'), h('a', { class: 'btn', href: GUIDE, target: '_blank' }, 'Read the full guide'))),
        h('div', { class: 'callout' }, 'Next: open a Google Meet, click the Debrief icon, and press Start recording this tab. You can reopen this tour any time from the popup (Take the tour).'),
      ];
    },
  },
];

// ------------------------------------------------------------------------------------------------

function renderNav() {
  $('stepsNav').replaceChildren(
    ...STEPS.map((st, i) => {
      const b = h('button', { class: `${i === tour.step ? 'active' : ''} ${tour.visited.includes(i) && i !== tour.step ? 'done' : ''}`, onclick: () => go(i) },
        h('span', { class: 'dot' }, tour.visited.includes(i) && i !== tour.step ? '✓' : String(i + 1)), st.label, st.optional ? h('span', { class: 'opt' }, 'optional') : null);
      return b;
    })
  );
}

async function go(i) {
  const cur = STEPS[tour.step];
  if (cur?.save && $('stage').children.length) await cur.save().catch(() => {});
  if (cur && !tour.visited.includes(tour.step)) tour.visited.push(tour.step);
  tour.step = Math.max(0, Math.min(STEPS.length - 1, i));
  if (tour.step === STEPS.length - 1) tour.done = true;
  await saveTour();
  render();
  window.scrollTo(0, 0);
}

function render() {
  const st = STEPS[tour.step];
  $('stage').replaceChildren(h('p', { class: 'kicker' }, st.kicker), h('h1', {}, st.title), h('p', { class: 'lede' }, st.lede), ...st.nodes());
  st.after?.();
  renderNav();
  $('count').textContent = `Step ${tour.step + 1} of ${STEPS.length}`;
  $('back').style.visibility = tour.step === 0 ? 'hidden' : 'visible';
  $('skip').style.display = st.optional ? '' : 'none';
  $('next').textContent = tour.step === STEPS.length - 1 ? 'Finish' : tour.step === 0 ? 'Start the tour' : 'Next';
  document.title = `${st.title} · Debrief`;
}

$('next').onclick = async () => {
  if (tour.step === STEPS.length - 1) {
    await go(tour.step);
    window.close();
    return;
  }
  await go(tour.step + 1);
};
$('skip').onclick = () => go(tour.step + 1);
$('back').onclick = () => go(tour.step - 1);
$('skipAll').onclick = async (e) => {
  e.preventDefault();
  tour.done = true;
  await saveTour();
  window.close();
};

(async () => {
  S = await getSettings();
  S.shareAutoFlag = S.shareMode === 'auto';
  const saved = (await chrome.storage.local.get('tour')).tour;
  const fresh = new URLSearchParams(location.search).get('restart') === '1';
  tour = saved && !fresh && !saved.done ? { visited: [], keyOk: false, ...saved } : { step: 0, visited: [], keyOk: !!saved?.keyOk };
  micOk = await navigator.permissions.query({ name: 'microphone' }).then((q) => q.state === 'granted').catch(() => false);
  try {
    for (const c of await chrome.commands.getAll()) if (c.shortcut) shortcuts[c.name] = c.shortcut;
  } catch {}
  const at = STEPS.findIndex((s) => s.id === location.hash.slice(1));
  if (at >= 0) tour.step = at;
  render();
})();
