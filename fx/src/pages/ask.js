// Ask page enhancer: the beam on the question box and on "Find a meeting", orbs for waiting, liquid scope control.
import { orbForStatus, orbifySpinners, searchBeam, ready } from '../common.js';

ready(() => {
  orbifySpinners();
  const askBox = document.getElementById('askBox');
  if (askBox) {
    let busy = false;
    const sync = searchBeam(askBox, { id: 'db-ask', strength: 0.9, busy: () => busy });
    const hook = () => {
      const st = askBox.querySelector(':scope > .hint');
      if (st && !st.dataset.orb) { st.dataset.orb = '1'; orbForStatus(st, { onChange: (s) => { busy = !!s; sync(); } }); }
    };
    new MutationObserver(hook).observe(askBox, { childList: true });
    hook();
  }
  const pick = document.getElementById('pickQ');
  if (pick) searchBeam(pick.closest('.row') || pick.parentElement, { id: 'db-search' });
});
