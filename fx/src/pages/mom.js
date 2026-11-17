// Minutes page enhancer: liquid Minutes/Transcript tabs and format switch, an orb for every wait (writing, reading,
// transcribing, emailing, looking for voices), the beam on the document card while minutes are written, and on the Ask box.
import { beam, gooSegmented, orbForStatus, orbifySpinners, orbStateFor, searchBeam, withMetal, ready } from '../common.js';

ready(() => {
  const $ = (id) => document.getElementById(id);
  const main = document.querySelector('main');

  // The page's script replaces <main> when the meeting id is unknown.
  const notFound = () => {
    if (!main || main.querySelector('.empty-state') || !/^\s*Meeting not found\.?\s*$/.test(main.textContent)) return false;
    main.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty-state card';
    const h = document.createElement('h1'); h.textContent = 'This meeting is not here';
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'It may have been deleted. Your other meetings are listed in the Debrief popup.';
    const a = document.createElement('a'); a.className = 'button primary'; a.href = 'ask.html'; a.textContent = 'Ask your meetings';
    box.append(h, p, a); main.append(box);
    return true;
  };
  if (notFound()) return;
  new MutationObserver(() => notFound()).observe(main, { childList: true });

  gooSegmented(document.querySelector('.tabs'));
  gooSegmented($('fmtSwitch'));
  gooSegmented($('edTabs'));
  orbifySpinners();

  // while minutes are written (or anything else runs) the document card glows and the status shows an orb
  const card = $('mom'); // the glow goes round the document card, where the skeleton and the status are, not round the toolbar
  const write = beam(card, 'db-write', { strength: 0.9 });
  orbForStatus($('genStatus'), { onChange: (s) => write(!!s && s !== 'breathing') });
  for (const id of ['pendingText', 'shareStatus', 'mailStatus', 'nameWhy', 'startCount']) orbForStatus($(id));

  // the orb on the document card's skeleton follows the stage the job reports (the page script mirrors the text into it)
  new MutationObserver(() => {
    const o = document.querySelector('#mom .skel db-orb');
    const st = orbStateFor($('genStatus').textContent);
    if (o && st && o.getAttribute('state') !== st) o.setAttribute('state', st);
  }).observe($('genStatus'), { childList: true, characterData: true, subtree: true });

  // the Ask box (built by the page script into #askBox)
  const askBox = $('askBox');
  if (askBox) {
    let busy = false;
    const sync = searchBeam(askBox, { id: 'db-ask', busy: () => busy });
    const hook = () => {
      const st = askBox.querySelector(':scope > .hint');
      if (st && !st.dataset.orb) {
        st.dataset.orb = '1';
        orbForStatus(st, { onChange: (s) => { busy = !!s; sync(); } });
      }
    };
    new MutationObserver(hook).observe(askBox, { childList: true });
    hook();
  }
});
