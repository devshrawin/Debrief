// First-run tour: teaches Debrief step by step, saves each answer, and tests the pieces that can be tested
// (the Gemini key, the microphone, the email relay) so the user finds out now, not in the middle of a meeting.
import { getSettings, setSetting, DEFAULTS, ensureEmailSecret } from './store.js';
import { generate } from './llm.js';
import { sendMail, mailReady, scriptWithAllowList, scriptWithSecret, parseAddresses, WEBAPP_URL } from './mailer.js';
import scriptText from '../apps-script/Code.gs';
import { LANGUAGES, chosenLanguages, minutesLanguageOptions } from './languages.js';


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
const card = (title, ...kids) => h('div', { class: 'card' }, title ? h('h2', { class: 'lbl' }, title) : null, ...kids);
const tight = (...kids) => h('div', { class: 'card tight' }, ...kids);
const p = (text, cls) => h('p', { class: cls || '' }, text);
const kbd = (t) => h('kbd', {}, t);
const steps = (...items) => h('ol', { class: 'steps' }, ...items.map((i) => h('li', {}, i)));
// Static inline icons only (never user text).
const svg = (inner, size = 20, attrs = '') => h('span', { html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${attrs}>${inner}</svg>` }).firstChild;
const status = () => h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
// kind: '' neutral text, 'load' spinner, 'ok' / 'bad' a result chip (label) then the text, 'warn' a warning chip.
const say = (el, text, kind, label) => {
  el.className = `status ${kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : ''}`;
  const kids = [];
  if (kind === 'load') kids.push(h('span', { class: 'spin', style: 'color: var(--brand)' }));
  if (kind === 'ok') kids.push(h('span', { class: 'chip ok' }, label || 'Done'));
  if (kind === 'bad') kids.push(h('span', { class: 'chip rec' }, label || 'Failed'));
  if (kind === 'warn') kids.push(h('span', { class: 'chip warn' }, label || 'Not yet'));
  if (text) kids.push(h('span', {}, text));
  el.replaceChildren(...kids);
};

// Writes only the keys given, on top of what is stored now, so an older copy of the settings held by this
// page can never overwrite changes made elsewhere.
async function patch(obj) {
  S = { ...S, ...obj };
  const { shareAutoFlag, ...clean } = obj; // shareAutoFlag is only a view of shareMode
  await setSetting(clean);
}
async function saveTour() {
  await chrome.storage.local.set({ tour });
}

// A switch row bound to a setting (a role=switch button, styled by .sw in style.css).
let swSeq = 0;
function toggle(key, title, sub, { invert = false, onChange } = {}) {
  const id = `sw${++swSeq}`;
  let on = key === 'shareAutoFlag' ? !!S.shareAutoFlag : invert ? !S[key] : !!S[key];
  const btn = h('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': `${id}t`, 'aria-describedby': `${id}d`, 'data-key': key });
  btn.onclick = async () => {
    on = !on;
    btn.setAttribute('aria-checked', String(on));
    if (key === 'shareAutoFlag') S.shareAutoFlag = on;
    else await patch({ [key]: invert ? !on : on });
    onChange?.(on);
  };
  return h('div', { class: 'trow' }, h('div', { class: 't' }, h('strong', { id: `${id}t` }, title), h('p', { class: 'hint', id: `${id}d` }, sub)), btn);
}
// A label above an input or textarea.
function field(label, id, value, { type = 'text', placeholder = '', area = false, hint = '' } = {}) {
  const el = area ? h('textarea', { id, class: 'inp', placeholder, rows: 5 }) : h('input', { id, class: 'inp', type, placeholder, autocomplete: 'off', spellcheck: 'false' });
  el.value = value || '';
  return h('div', { class: 'fld' }, label ? h('label', { for: id }, label) : null, el, hint ? h('p', { class: 'hint' }, hint) : null);
}
// A setting with a select on the right.
function selectRow(title, sub, select) {
  return h('div', { class: 'trow' }, h('div', { class: 't' }, h('label', { for: select.id }, title), h('p', { class: 'hint' }, sub)), select);
}
const sel = (id, options, onchange) => h('select', { id, class: 'inp', onchange }, ...options.map(([v, l]) => h('option', { value: v }, l)));

// ------------------------------------------------------------------------------------------------
// Steps. Each has { id, label, title, lede, optional, nodes(), after?(), save?() }
// ------------------------------------------------------------------------------------------------
const ALL = [
  {
    id: 'key',
    label: 'Gemini key',
    title: 'Add your free Gemini key',
    lede: 'Gemini turns the speech into text and writes the minutes. Google gives you a free key; no card is needed.',
    nodes: () => {
      const st = status();
      const inp = field('', 't-key', S.geminiKey, { type: 'password', placeholder: 'Paste your key here' });
      const input = inp.querySelector('input');
      input.setAttribute('aria-describedby', 't-key-r');
      st.id = 't-key-r';
      const show = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => {
        const on = input.type === 'password';
        input.type = on ? 'text' : 'password';
        show.setAttribute('aria-pressed', String(on));
        show.textContent = on ? 'Hide' : 'Show';
      } }, 'Show');
      const test = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        const key = input.value.trim();
        if (!key) return say(st, 'Paste your key first.', 'bad', 'No key');
        test.disabled = true;
        test.textContent = 'Testing…';
        test.setAttribute('aria-busy', 'true');
        say(st, 'Asking Google…', 'load');
        await patch({ geminiKey: key, geminiKey2: $('t-key2').value.trim() });
        try {
          const out = await generate({ settings: { ...S, llmProvider: 'gemini' }, system: 'You are a connectivity test.', user: 'Reply with exactly: OK', onText: () => {} });
          tour.keyOk = true;
          await saveTour();
          say(st, `Google accepted the key (it answered "${out.trim().slice(0, 12)}").`, 'ok', 'Working');
        } catch (e) {
          say(st, `That did not work: ${e.message.slice(0, 160)}`, 'bad', 'Not working');
        }
        test.disabled = false;
        test.textContent = 'Test my key';
        test.removeAttribute('aria-busy');
      } }, 'Test my key');
      say(st, 'Paste the key, then test it. It is saved on this computer only.');
      return [
        card('',
          h('label', { for: 't-key', style: 'margin: 0' }, 'Your Gemini key'),
          h('div', { class: 'rowf' }, input, show, test),
          st,
          h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', style: 'font-weight: 600; align-self: flex-start' }, 'Get a free key from Google AI Studio (2 min)'),
          steps(
            h('span', {}, 'Open aistudio.google.com/apikey and sign in with a Google account.'),
            h('span', {}, 'Click ', h('b', {}, 'Create API key'), ' and copy it.'),
            h('span', {}, 'Paste it above and press ', h('b', {}, 'Test my key'), '.'))),
        h('div', { class: 'callout warnc' }, svg('<path d="M12 3l9.5 17h-19z"></path><path d="M12 10v4M12 17v.5"></path>', 20, 'stroke="currentColor"'),
          p("On the free tier Google may use what you send to improve its products, and reviewers may read it. For confidential meetings, turn on billing for the key, pick another provider in Settings, or keep everything local (Set up more → Local models).")),
        card('Good to know',
          p('The free tier has daily limits per model, so very long or many meetings in one day can hit them. Debrief switches to other models automatically, keeps any audio it could not process, and shows a red alert if a limit stops it.'),
          field('Backup key (optional)', 't-key2', S.geminiKey2, { type: 'password', placeholder: 'A key from a different Google Cloud project', hint: 'Limits count per project, so a backup only helps if it comes from a different project.' })),
      ];
    },
    save: async () => patch({ geminiKey: $('t-key').value.trim(), geminiKey2: $('t-key2').value.trim() }),
  },
  {
    id: 'mic',
    label: 'Microphone',
    title: 'Your microphone',
    lede: 'Debrief always records the other people from the tab. To include your own voice it also needs your microphone.',
    optional: true,
    nodes: () => {
      const st = status();
      if (micOk) say(st, 'Microphone allowed.', 'ok', 'Allowed');
      else say(st, '', 'warn', 'Not allowed yet');
      return [
        card('',
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn primary', onclick: async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach((t) => t.stop());
              micOk = true;
              say(st, '', 'ok', 'Allowed');
            } catch (e) {
              say(st, `${e.message}. You can allow it later from the lock icon in the address bar or in Settings.`, 'bad', 'Not allowed');
            }
          } }, 'Allow microphone'), st),
          p('Chrome asks once. Press the button and choose Allow. Debrief only listens while you are recording.'),
          p('If you skip this: other people are still recorded, but your own voice will be missing from the minutes.', 'hint')),
        tight(
          toggle('captureMic', 'Include my microphone', 'Your own voice goes into the transcript, labelled with your name.'),
          toggle('followMeetMute', 'Pause my mic while muted in the meeting', "Muting yourself in the meeting app does not mute Debrief by itself, so this makes Debrief follow the app's mute button. Side conversations stay out of the transcript.")),
        p('You can also switch your voice in or out at any time from the popup or with the keyboard.', 'hint'),
      ];
    },
  },
  {
    id: 'ready',
    label: 'Ready',
    title: 'You are ready',
    lede: 'Join your meeting in Chrome, click the Debrief icon and press Start recording this tab. Everything else is optional and can be done any time in Settings.',
    nodes: () => {
      const dictLines = S.dictionary.trim() ? S.dictionary.trim().split('\n').length : 0;
      const nShare = parseAddresses(S.shareList).length;
      const more = [
        ['you', 'Your name and languages', S.myName || 'Labels your lines in the transcript.'],
        ['names', 'Names and terms', dictLines ? `${dictLines} ${dictLines === 1 ? 'entry' : 'entries'}.` : 'Spell your team\'s names right.'],
        ['voices', 'Voices', 'Recognise people by their voice, on your computer.'],
        ['email', 'Email the minutes to yourself', mailReady(S) ? 'Ready.' : 'Not set up.'],
        ['share', 'Share with your team', nShare ? `${nShare} ${nShare === 1 ? 'person' : 'people'}.` : 'No one added.'],
        ['local', 'Local models', 'Keep audio and text on your computer.'],
        ['usage', 'Limits and usage', 'See how much of the free allowance is left.'],
      ];
      return [
        card('Set up more (optional)',
          p('Each one is a short step with its own test, and can be skipped. Settings has the same things. You can come back any time from the popup (Take the tour).', 'hint'),
          h('ul', { class: 'checklist', 'aria-label': 'More to set up' }, ...more.map(([id, title, sub]) => h('li', {},
            h('span', { class: 'txt' }, h('strong', {}, title), h('span', { class: 'sub' }, sub)),
            h('button', { type: 'button', class: 'btn', onclick: () => openMore(id) }, 'Set up'))))),
        h('div', { class: 'card promise' }, svg('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"></path><path d="M8.5 12l2.5 2.5 4.5-5"></path>', 28),
          h('div', {}, h('strong', {}, 'Our privacy promise'),
            p('Debrief has no server of its own. Your keys stay in this browser. Audio and text go only to the services you choose, to do their job. If you turn on email, the minutes also pass through a script in your own Google account. Recognising voices happens on your computer.'))),
        h('div', { class: 'callout' }, svg('<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.5"></path>', 20, 'stroke="currentColor"'), p('Tell participants when you are recording. Your company may also restrict browser extensions or tab capture.')),
        card('Cheat sheet',
          h('div', { class: 'cols' },
            h('div', { class: 'mini' }, h('b', {}, 'Start or stop'), kbd(shortcuts['toggle-recording'] || 'Alt+Shift+M'), ' or the toolbar icon'),
            h('div', { class: 'mini' }, h('b', {}, 'My voice in or out'), kbd(shortcuts['toggle-mic'] || 'Alt+Shift+K'), ' or the popup switch'),
            h('div', { class: 'mini' }, h('b', {}, 'Past meetings'), 'Popup → Meetings tab'),
            h('div', { class: 'mini' }, h('b', {}, 'Change anything'), 'Popup → Settings')),
          h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html', target: '_blank' }, 'Open Settings'))),
      ];
    },
  },
  {
    id: 'you',
    label: 'You and language',
    title: 'Your name and languages',
    lede: 'Your name labels your lines in the transcript. The languages tune the speech recognition.',
    nodes: () => [
      card('',
        field('Your name', 't-name', S.myName, { placeholder: 'e.g. Shrawin Sisodiya', hint: 'Your voice is labelled with this name.' }),
        h('div', { class: 'fld' },
          h('span', { id: 't-langs-l', style: 'font-weight: 600' }, 'Languages spoken in your meetings (pick any number)'),
          h('div', { class: 'chips', id: 't-langs', role: 'group', 'aria-labelledby': 't-langs-l' }, ...LANGUAGES.map((l) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', 'data-lang': l.code }), l.name))),
          p('Leave all unticked for automatic. Picking just the languages you really use makes the text more accurate.', 'hint')),
        h('div', { class: 'fld', style: 'max-width: 320px' },
          h('label', { for: 't-mom' }, 'Language of the written minutes'),
          h('select', { id: 't-mom', class: 'inp' }, ...minutesLanguageOptions().map((o) => h('option', { value: o.value }, o.label))))),
    ],
    after: () => {
      const chosen = new Set((chosenLanguages(S) || []).map((l) => l.code));
      document.querySelectorAll('#t-langs input').forEach((c) => (c.checked = chosen.has(c.dataset.lang)));
      $('t-mom').value = S.momLanguage;
    },
    save: async () => patch({ myName: $('t-name').value.trim(), meetingLanguages: [...document.querySelectorAll('#t-langs input:checked')].map((c) => c.dataset.lang), momLanguage: $('t-mom').value }),
  },
  {
    id: 'names',
    label: 'Names and terms',
    title: 'Teach Debrief your names',
    lede: 'Speech recognition guesses unusual names and local terms: "Amal" often comes out as "Aman". A short dictionary fixes this for good.',
    optional: true,
    nodes: () => [
      card('',
        field('Names and words Debrief should spell right', 't-dict', S.dictionary, { area: true, placeholder: 'Amal | Aman, Amaal\nPriya Nair\nUnified Registry\nDSM',
          hint: 'One entry per line. Write the correct spelling, then a bar, then the wrong versions Debrief tends to produce. A line with only a name or term is just a spelling hint. Used as a hint to the speech model, as an automatic correction of the transcript, and by the minutes writer.' })),
      card('Two more tools you will meet later',
        steps(
          h('span', {}, h('b', {}, 'Who was in the meeting'), ': on each minutes page you can list the attendees. Then "Aman" is corrected to "Amal" only if Amal is there and Aman is not.'),
          h('span', {}, h('b', {}, 'Fix a name everywhere'), ': spot a wrong name in the minutes, type the wrong and right spelling once, and it is corrected in the transcript and minutes and remembered for next time.'))),
    ],
    save: async () => patch({ dictionary: $('t-dict').value }),
  },
  {
    id: 'record',
    label: 'Recording',
    title: 'Recording your first meeting',
    lede: 'Here is exactly what to do in a meeting, and what Debrief does for you.',
    nodes: () => [
      card('In the meeting',
        steps(
          h('span', {}, 'Join your meeting in Chrome as usual (Google Meet, or Zoom, Teams and others in the browser) and keep that tab in front. The Debrief icon glows amber on the tab while a call is on, as a reminder to record.'),
          h('span', {}, 'Click the Debrief icon in the toolbar and press ', h('b', {}, 'Start recording this tab'), ', or just press ', kbd(shortcuts['toggle-recording'] || 'Alt+Shift+M'), '. The icon shows a red REC badge.'),
          h('span', {}, 'Open the popup any time to see two level bars: ', h('b', {}, 'Meeting audio'), ' should move when others speak, and ', h('b', {}, 'Your mic'), ' when you do. If they say "silent", fix the sound before you have lost minutes.'),
          h('span', {}, 'To leave your own voice out for a while, use the switch in the popup or press ', kbd(shortcuts['toggle-mic'] || 'Alt+Shift+K'), '.'),
          h('span', {}, 'When the meeting ends, Debrief stops by itself, opens the minutes in a background tab, and writes them. This takes a minute or two. You can also press ', h('b', {}, 'Stop & write MOM'), ' yourself.'),
          h('span', {}, 'On the minutes page, check names and numbers, list the attendees if you like, then copy, download or share them. Keep the tab open until it says "Emailed ✓" if email is on.'))),
      tight(
        toggle('autoStop', 'Stop when the meeting ends', 'Notices the "you left" or "meeting ended" screen, or you leaving the call page.'),
        selectRow('Also stop after silence', 'A safety net for when nobody has made a sound for that long.',
          sel('t-quiet', [['0', 'Never'], ['5', 'After 5 quiet minutes'], ['10', 'After 10 quiet minutes'], ['15', 'After 15 quiet minutes'], ['30', 'After 30 quiet minutes']], (e) => patch({ autoStopQuietMin: Number(e.target.value) }))),
        toggle('pillOnPage', 'Show a small recording pill on the call', 'A draggable capsule with the timer, a mic switch and alerts. Off by default so nothing covers your meeting.'),
        selectRow('Speaker names (Google Meet only)', "Meet's live captions say who is speaking, so the minutes can name people. Turning captions on shows subtitles on your screen.",
          sel('t-cap', [['read', "Use Meet's captions when I have them on"], ['auto', 'Turn captions on for me while recording'], ['off', "Don't read captions"]], (e) => patch({ meetCaptions: e.target.value })))),
      p('In the popup, "Check page detection" shows what Debrief can read from your meeting page. Use it once in a call to see that the mute button, speaker names and attendance are recognised.', 'hint'),
    ],
    after: () => {
      $('t-quiet').value = String(S.autoStopQuietMin ?? 10);
      $('t-cap').value = S.meetCaptions || 'read';
    },
  },
  {
    id: 'voices',
    label: 'Who is speaking',
    title: 'Put names to voices',
    lede: 'Optional. Debrief can guess who is speaking from the sound of their voice, so the transcript and minutes can say "Priya" instead of "Others". It is a best guess and says "Unknown speaker" when unsure.',
    optional: true,
    nodes: () => [
      card('What to expect',
        h('ul', { class: 'bul' },
          h('li', {}, 'Everything happens in your browser. A small speaker model that ships with the extension (WeSpeaker ResNet34, 26 MB, CC-BY-4.0) turns short stretches of speech into a list of 256 numbers. Audio is never saved or sent anywhere for this.'),
          h('li', {}, 'You add people in ', h('b', {}, 'Settings → Voices'), ' by recording about 20 seconds of each person reading a short text, in the language they use in meetings (English, Hindi, Malayalam or free speech). Only the numbers are stored.'),
          h('li', {}, 'Overlapping speech, unfamiliar voices and noisy stretches show as ', h('b', {}, 'Unknown speaker'), ", and where Meet's captions name someone else, both names are shown."),
          h('li', {}, 'Accuracy depends on microphones and rooms. Check the names against what you remember before relying on them.'))),
      tight(
        toggle('voiceOn', 'Name speakers by their voice (best guess)', 'Uses the voices you add in Settings. Off by default.'),
        toggle('voiceLearn', 'Learn voices on its own from my meetings', 'Groups voices that keep coming back and lists them as "Unnamed voice" for you to rename once, in any language. Meet\'s captions help name them when available but are not needed. A learned voice is not used until it has been heard in two meetings. Tell your colleagues, and delete anyone any time.')),
      h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html#voices', target: '_blank' }, 'Open Voices settings'), h('span', { class: 'hint' }, 'Fine to skip. Later: Settings → Voices. "Forget all voices" there deletes every fingerprint.')),
    ],
  },
  {
    id: 'email',
    label: 'Email the minutes',
    title: 'Get the minutes by email',
    lede: 'Optional, and worth the two minutes. The minutes arrive in your inbox as soon as they are written, sent from your own Google account through a small script you control. No Debrief server is involved.',
    optional: true,
    nodes: () => {
      const st = status();
      const copyMsg = status();
      const vmsg = h('p', { class: 'vmsg', id: 't-hook-m', role: 'status', 'aria-live': 'polite' });
      const hook = field('Web app URL', 't-hook', S.emailWebhook, { placeholder: 'https://script.google.com/macros/s/…/exec' });
      const input = hook.querySelector('input');
      input.setAttribute('aria-describedby', 't-hook-m');
      const validate = () => {
        const v = input.value.trim();
        input.removeAttribute('aria-invalid');
        input.classList.remove('okf');
        vmsg.className = 'vmsg';
        if (!v) vmsg.textContent = 'Paste the address you copied after deploying. It ends in /exec.';
        else if (WEBAPP_URL.test(v)) {
          input.setAttribute('aria-invalid', 'false');
          input.classList.add('okf');
          vmsg.className = 'vmsg ok';
          vmsg.textContent = 'Looks right.';
        } else {
          input.setAttribute('aria-invalid', 'true');
          vmsg.className = 'vmsg bad';
          vmsg.textContent = /^https:\/\/script\.google\.com\/.*\/dev(\?|$)/.test(v) ? 'That is the test address (ends in /dev). Use the Web app URL that ends in /exec.' : 'That does not look like a Web app URL. It starts with https://script.google.com/ and ends in /exec.';
        }
      };
      input.addEventListener('input', validate);
      validate();
      hook.append(vmsg);
      return [
        card('',
          h('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap' }, h('strong', {}, 'Connect your Gmail'),
            h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
              try {
                await navigator.clipboard.writeText(scriptWithSecret(scriptText, await ensureEmailSecret()));
                say(copyMsg, '', 'ok', 'Copied');
              } catch (e) {
                say(copyMsg, `Could not copy: ${e.message}`, 'bad', 'Not copied');
              }
            } }, 'Copy the script'), copyMsg)),
          p('Press Copy the script, then:'),
          steps(
            h('span', {}, 'Open ', h('a', { href: 'https://script.google.com/home/start', target: '_blank', rel: 'noopener' }, 'script.google.com'), ', click ', h('b', {}, 'New project'), ', click in the code box, press ', kbd('Ctrl+A'), ' then ', kbd('Ctrl+V'), ' to replace everything, and save with ', kbd('Ctrl+S'), '.'),
            h('span', {}, 'In the toolbar choose the function ', h('b', {}, 'authorize'), ' and press ', h('b', {}, 'Run'), '. Allow access when Google asks (click ', h('i', {}, 'Advanced → Go to … (unsafe)'), ' if it warns, it is your own script).'),
            h('span', {}, 'Click ', h('b', {}, 'Deploy → New deployment'), ', choose ', h('b', {}, 'Web app'), ', set ', h('b', {}, 'Who has access'), ' to ', h('b', {}, 'Anyone'), ', and click ', h('b', {}, 'Deploy'), '.'),
            h('span', {}, 'Copy the ', h('b', {}, 'Web app URL'), ' (it ends in /exec) and paste it below.')),
          hook,
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
            await patch({ emailWebhook: input.value.trim() });
            say(st, 'Sending…', 'load');
            try {
              const r = await sendMail({ subject: 'Debrief test email', html: '<p>This is a test from <b>Debrief</b>. Your minutes will arrive like this.</p>', text: 'This is a test from Debrief.', attachments: [] }, S);
              say(st, `Sent to ${r.to}. Check your inbox.`, 'ok', 'Sent');
            } catch (e) {
              say(st, e.message, 'bad', 'Failed');
            }
          } }, 'Send test email'), st)),
        tight(
          toggle('emailAuto', 'Send automatically', 'Email the minutes as soon as they are written.'),
          toggle('emailPdf', 'Attach a PDF', 'A formatted A4 copy of the minutes.'),
          toggle('emailWord', 'Attach a Word file', 'Opens in Word with tables intact.'),
          toggle('emailTranscript', 'Attach the transcript', 'The full transcript as a text file.')),
      ];
    },
    save: async () => patch({ emailWebhook: $('t-hook')?.value.trim() ?? S.emailWebhook }),
  },
  {
    id: 'share',
    label: 'Share and calendar',
    title: 'Share with your team',
    lede: 'Optional. Debrief can send the minutes to colleagues and show who was invited versus who actually came.',
    optional: true,
    nodes: () => {
      const msg = status();
      return [
        card('Who should get a copy',
          field('Usually share the minutes with', 't-share', S.shareList, { area: true, placeholder: 'priya@company.com, ravi@company.com', hint: 'You always get the email first. After you check names and numbers on the minutes page, press Share. For a recurring meeting with its own team, add lines like "Cadence Call | a@x.com, b@x.com" later in Settings → Email.' }),
          tight(toggle('shareAutoFlag', 'Send to them automatically', 'They get a copy the moment the minutes are written, without your review.', { onChange: (on) => patch({ shareMode: on ? 'auto' : 'review' }) }))),
        card('Allow them in your script',
          p('Your script only mails people you allow, so nobody else can use it to send mail. After you add people, copy the updated script, replace the one at script.google.com, and deploy a new version (Deploy → Manage deployments → pencil → Version: New version → Deploy).'),
          toggle('shareDomains', 'Allow everyone at their company', 'Uses the part after the @, so new colleagues work without editing the script.'),
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
            await patch({ shareList: $('t-share').value });
            try {
              await navigator.clipboard.writeText(scriptWithAllowList(scriptText, parseAddresses($('t-share').value), { domains: S.shareDomains, secret: await ensureEmailSecret() }));
              say(msg, 'The script with these people allowed is on your clipboard.', 'ok', 'Copied');
            } catch (e) {
              say(msg, `Could not copy: ${e.message}`, 'bad', 'Not copied');
            }
          } }, 'Copy script with these people allowed'), msg)),
        card('Invited versus attended',
          toggle('calendarLookup', 'Look up who was invited', "Reads each meeting's invite from your Google Calendar through the same script. Needs the authorize step from the email page to have been run, and a new deployment if you changed the script."),
          p('The minutes then include an attendance table: who came, who was absent, who joined late or left early, and anyone who was not invited. Who actually attended is read from the people shown in the Meet call.', 'hint')),
      ];
    },
    save: async () => patch({ shareList: $('t-share')?.value ?? S.shareList }),
  },
  {
    id: 'local',
    label: 'Local models',
    title: 'Keeping everything on your computer',
    lede: 'Optional. If you do not want meeting text to leave your PC, Debrief can use models running locally instead of Gemini.',
    optional: true,
    nodes: () => [
      card('What is possible',
        h('div', { class: 'cols' },
          h('div', { class: 'mini' }, h('b', {}, 'Writing the minutes'), 'Ollama with Gemma, Qwen, Llama and others. Good for clear English or Hinglish, slower and weaker on long or messy meetings.'),
          h('div', { class: 'mini' }, h('b', {}, 'Speech to text'), 'A local Whisper-style server. Good for English and Hindi; Malayalam needs a Malayalam model.')),
        p('Setup takes a few commands and one Debrief button each. Open Settings → Minutes and press "Use Ollama on this PC", then "Find my installed models".'),
        h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html#minutes', target: '_blank' }, 'Open Minutes settings'))),
      card('Other meeting apps',
        p('Recording, transcription, minutes and email work on any web meeting tab. Speaker names, captions and who joined come from Google Meet only. For Zoom (in the browser), Teams, Webex, Whereby, Jitsi, GoTo Meeting, BlueJeans, Chime, Zoho Meeting and Skype for Web, Debrief also glows amber during a call, follows your mute button and stops when the call ends. This uses best-effort generic detection, so "Check page detection" in the popup tells you what it can read. Installed desktop apps (the Zoom or Teams program) cannot be recorded by a browser extension.')),
    ],
  },
  {
    id: 'usage',
    label: 'Limits and usage',
    title: 'Keeping an eye on limits',
    lede: 'Free services have daily limits. Debrief counts what it uses and tells you before and when you hit one.',
    optional: true,
    nodes: () => [
      card('What you will see',
        steps(
          h('span', {}, h('b', {}, 'A yellow warning in the popup'), ' when a model is at 80% of its daily limit.'),
          h('span', {}, h('b', {}, 'A red alert and a Chrome notification'), ' if a limit or a bad key stops a request. Nothing is lost: audio that could not be transcribed is kept and retried when you open the minutes page.'),
          h('span', {}, h('b', {}, 'The Usage page in Settings'), " with requests, tokens, audio minutes and the limits Debrief has learned from Google's own messages. Days roll over at midnight Pacific time."))),
      card('',
        p('Thorough minutes (the default) make a few extra requests per meeting to catch every action item. If you run out of free requests often, switch Settings → Minutes to "Quick".'),
        h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html#usage', target: '_blank' }, 'Open the Usage page'))),
    ],
  },
  {
    id: 'done',
    label: 'All set',
    title: 'You are ready',
    lede: 'Here is where things stand. Anything not set can be done later in Settings.',
    nodes: () => {
      const item = (ok, optional, title, sub) => h('li', { class: ok ? 'ok' : '' },
        h('span', { class: 'num', 'aria-hidden': 'true' }, ok ? '✓' : '–'),
        h('span', { class: 'txt' }, h('strong', {}, title), h('span', { class: 'sub' }, sub)),
        h('span', { class: `chip ${ok ? 'ok' : 'warn'}` }, ok ? 'Ready' : optional ? 'Optional, not set' : 'Not set'));
      const dictLines = S.dictionary.trim() ? S.dictionary.trim().split('\n').length : 0;
      return [
        h('div', { class: 'card checkcard' }, h('ul', { class: 'checklist', 'aria-label': 'Your setup' },
          item(tour.keyOk || !!S.geminiKey, false, 'Gemini key', tour.keyOk ? 'Tested and working.' : S.geminiKey ? 'Saved (not tested).' : 'Not added yet: you need this to record.'),
          item(micOk, true, 'Microphone', micOk ? 'Allowed.' : 'Not allowed yet. Only the other participants are recorded.'),
          item(!!S.myName, true, 'Your name', S.myName || 'Not set.'),
          item(!!dictLines, true, 'Names and terms', dictLines ? `${dictLines} ${dictLines === 1 ? 'entry' : 'entries'}.` : "Empty. Add your team's names later."),
          item(mailReady(S), true, 'Email', mailReady(S) ? 'Ready.' : 'Not set up.'),
          item(parseAddresses(S.shareList).length > 0, true, 'Sharing', parseAddresses(S.shareList).length ? `${parseAddresses(S.shareList).length} people.` : 'No one added.'),
          item(S.autoStop, true, 'Stops by itself', S.autoStop ? 'On.' : 'Off: stop recordings manually.'))),
        card('Cheat sheet',
          h('div', { class: 'cols' },
            h('div', { class: 'mini' }, h('b', {}, 'Start or stop'), kbd(shortcuts['toggle-recording'] || 'Alt+Shift+M'), ' or the toolbar icon'),
            h('div', { class: 'mini' }, h('b', {}, 'My voice in or out'), kbd(shortcuts['toggle-mic'] || 'Alt+Shift+K'), ' or the popup switch'),
            h('div', { class: 'mini' }, h('b', {}, 'Past meetings'), 'Popup → Meetings tab'),
            h('div', { class: 'mini' }, h('b', {}, 'Change anything'), 'Popup → Settings')),
          h('div', { class: 'btnrow' }, h('a', { class: 'btn', href: 'options.html', target: '_blank' }, 'Open Settings'))),
        h('div', { class: 'callout' }, p('Next: join an online meeting in Chrome, click the Debrief icon, and press Start recording this tab. You can reopen this tour any time from the popup (Take the tour).')),
      ];
    },
  },
];

// First run: two steps (key, microphone) and "You are ready". The rest is opened from "Set up more" and is all optional.
const visibleSteps = () => (tour.more ? ALL : ALL.slice(0, 3));
async function openMore(id) {
  tour.more = true;
  await go(ALL.findIndex((st) => st.id === id));
}

// ------------------------------------------------------------------------------------------------

function renderNav() {
  $('stepsNav').replaceChildren(
    ...visibleSteps().map((st, i) => {
      const cur = i === tour.step;
      const done = tour.visited.includes(i) && !cur && i < tour.step; // steps ahead of you are not done, whatever you visited before
      const b = h('button', { type: 'button', class: done ? 'isdone' : '', 'aria-current': cur ? 'step' : false, onclick: () => go(i) },
        h('span', { class: 'num', 'aria-hidden': 'true' }, done ? '✓' : String(i + 1)),
        h('span', { class: 'nm' }, st.label, done ? h('span', { class: 'vh' }, ' (done)') : null),
        st.optional ? h('span', { class: 'opt' }, 'optional') : null);
      return h('li', { class: cur ? 'cur' : '' }, b);
    })
  );
}

async function go(i) {
  const cur = visibleSteps()[tour.step];
  if (cur?.save && $('stage').children.length) await cur.save().catch(() => {});
  if (cur && !tour.visited.includes(tour.step)) tour.visited.push(tour.step);
  tour.step = Math.max(0, Math.min(visibleSteps().length - 1, i));
  if (tour.step === visibleSteps().length - 1) tour.done = true;
  await saveTour();
  render();
  window.scrollTo(0, 0);
  $('stage').querySelector('h1')?.focus({ preventScroll: true });
}

function render() {
  const st = visibleSteps()[tour.step];
  const n = tour.step + 1;
  const last = visibleSteps().length - 1;
  $('stage').replaceChildren(h('div', { class: 'wrap' },
    h('div', {}, h('p', { class: 'lbl kicker' }, `Step ${n}${st.optional ? ' · optional' : ''}`), h('h1', { tabindex: '-1' }, st.title), h('p', { class: 'lede' }, st.lede)),
    ...st.nodes()));
  st.after?.();
  renderNav();
  $('count').textContent = `Step ${n} of ${visibleSteps().length}`;
  const stepsLeft = visibleSteps().length - n;
  $('left').textContent = stepsLeft > 0 ? `${stepsLeft} step${stepsLeft === 1 ? '' : 's'} left` : 'last step';
  $('bar').setAttribute('aria-valuenow', String(n));
  $('bar').setAttribute('aria-valuemax', String(visibleSteps().length));
  $('barfill').style.width = `${Math.round((n / visibleSteps().length) * 100)}%`;
  $('back').style.visibility = tour.step === 0 ? 'hidden' : 'visible';
  $('skip').style.display = tour.step < last ? '' : 'none';
  $('next').textContent = tour.step === last ? 'Finish' : 'Next';
  document.title = `${st.title} · Debrief`;
}

$('next').onclick = async () => {
  if (tour.step === visibleSteps().length - 1) {
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
  const at = ALL.findIndex((s) => s.id === location.hash.slice(1));
  if (at >= 0) {
    tour.step = at;
    if (at > 2) tour.more = true;
  }
  render();
})();
