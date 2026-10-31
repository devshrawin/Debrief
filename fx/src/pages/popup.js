// Popup enhancer: liquid tabs and mode switch, the recording beam, the call-detected state, orbs for every wait, a beam on
// meeting search. Reads state from the DOM and the action badge the background already sets; never changes behaviour.
import { beam, gooSegmented, orbForStatus, orbifySpinners, searchBeam, withMetal, ready } from '../common.js';

ready(async () => {
  const $ = (id) => document.getElementById(id);
  gooSegmented($('tabs'));
  gooSegmented($('modeSeg'));
  orbifySpinners();
  orbForStatus($('statusText'));
  orbForStatus($('error'));

  // search in the Meetings tab
  const sw = document.querySelector('.searchwrap');
  searchBeam(sw);

  const bar = document.querySelector('header.recbar');
  const recBeam = beam(bar, 'db-rec', { strength: 0.85 });
  const callBeam = beam($('start'), 'db-call', { strength: 0.9 });
  let metal = null;
  let callOn = false;
  const checkCall = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) callOn = (await chrome.action.getBadgeText({ tabId: tab.id })) === '●';
    } catch {}
    sync();
  };
  const sync = () => {
    const recording = !$('recView').classList.contains('hidden');
    recBeam(recording);
    const call = callOn && !recording && !$('start').disabled;
    callBeam(call);
    if (call && !metal) withMetal((M) => { if (!metal) { metal = M.ring($('start'), { strength: 0.9, ring: 2 }); if (metal) $('start').classList.add('metal-on'); } });
    if (!call && metal) { metal.destroy(); metal = null; $('start').classList.remove('metal-on'); }
  };
  for (const id of ['recView', 'start']) new MutationObserver(sync).observe($(id), { attributes: true, attributeFilter: ['class', 'disabled'] });
  addEventListener('focus', checkCall);
  checkCall();
});
