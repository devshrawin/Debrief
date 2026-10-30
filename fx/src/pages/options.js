// Settings enhancer: liquid segmented controls, orbs and a beam while a test runs, and the Appearance page (theme,
// transparency, moving background, animated effects). Appearance choices are saved at once, in their own storage keys.
import { gooSegmented, orbifySpinners, watchStatuses, ready } from '../common.js';

ready(() => {
  for (const id of ['usageRange', 'enrolLang', 'minutesFormatSeg', 'minutesModeSeg', 'uiTheme', 'uiMotion']) gooSegmented(document.getElementById(id));
  document.querySelectorAll('.seg-ctl[data-seg-for]').forEach((g) => gooSegmented(g));
  orbifySpinners();
  watchStatuses(document.querySelector('main.content') || document.body, '.status, #checkupMsg, #mailMsg, #copyMsg, #copyAllowMsg, #voiceShareMsg, #enrolMsg, #presetMsg, #voiceBlockedMsg');

  // Appearance
  const store = chrome.storage.local;
  const segs = { uiTheme: 'auto', uiMotion: 'lively' };
  const paint = (id, value) => document.querySelectorAll(`#${id} > button`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === value)));
  store.get(['uiTheme', 'uiMotion', 'uiSolid', 'uiEffects', 'uiPanel', 'uiSide']).then((r) => {
    for (const id of Object.keys(segs)) paint(id, r[id] || segs[id]);
    const solid = document.getElementById('uiSolid');
    if (solid) solid.checked = !!r.uiSolid;
    const pn = document.getElementById('uiPanel');
    if (pn) pn.checked = r.uiPanel !== false;
    const sd = document.getElementById('uiSide');
    if (sd) sd.checked = !!r.uiSide;
    const fx = document.getElementById('uiEffects');
    if (fx) fx.checked = r.uiEffects !== false;
  });
  for (const id of Object.keys(segs)) {
    document.querySelectorAll(`#${id} > button`).forEach((b) => b.addEventListener('click', () => {
      paint(id, b.dataset.v);
      store.set({ [id]: b.dataset.v });
    }));
  }
  document.getElementById('uiSolid')?.addEventListener('change', (e) => store.set({ uiSolid: e.target.checked }));
  document.getElementById('uiPanel')?.addEventListener('change', (e) => store.set({ uiPanel: e.target.checked }));
  document.getElementById('uiSide')?.addEventListener('change', (e) => store.set({ uiSide: e.target.checked }));
  document.getElementById('uiEffects')?.addEventListener('change', (e) => store.set({ uiEffects: e.target.checked }));
});
