// Settings enhancer: liquid segmented controls, orbs and a beam while a test runs, a fluid-colour room, and the in-app
// "Reduce transparency" switch (own storage key).
import { gooSegmented, orbifySpinners, watchStatuses, ready } from '../common.js';

ready(() => {
  for (const id of ['usageRange', 'enrolLang', 'minutesFormatSeg', 'minutesModeSeg']) gooSegmented(document.getElementById(id));
  document.querySelectorAll('.seg-ctl[data-seg-for]').forEach((g) => gooSegmented(g));
  orbifySpinners();
  watchStatuses(document.querySelector('main.content') || document.body, '.status, #checkupMsg, #mailMsg, #copyMsg, #copyAllowMsg, #voiceShareMsg, #enrolMsg, #presetMsg, #voiceBlockedMsg');

  const solid = document.getElementById('uiSolid');
  if (solid) {
    chrome.storage.local.get('uiSolid').then((r) => { solid.checked = !!r.uiSolid; });
    solid.addEventListener('change', () => chrome.storage.local.set({ uiSolid: solid.checked }));
  }
});
