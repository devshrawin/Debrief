// Ask page enhancer: the beam on the question box and on "Find a meeting", orbs for waiting, liquid scope control.
import { orbForStatus, orbifySpinners, searchBeam, ready } from '../common.js';

ready(() => {
  orbifySpinners();
  const askBox = document.getElementById('askBox');
  if (askBox) {
    let busy = false;
    let sync = () => {};
    // the beam belongs to the question field itself (the box also holds the suggestion chips, and a glow along the bottom of the whole box
    // looked like a stray light below them). The field may not be built yet when this runs, so it is picked up as soon as it appears.
    const attach = () => {
      const row = askBox.querySelector('.ask-row');
      if (!row || row.dataset.beamed) return;
      row.dataset.beamed = '1';
      sync = searchBeam(row, { id: 'db-ask', strength: 0.9, busy: () => busy });
    };
    const hook = () => {
      attach();
      const st = askBox.querySelector(':scope > .hint');
      if (st && !st.dataset.orb) { st.dataset.orb = '1'; orbForStatus(st, { onChange: (s) => { busy = !!s; sync(); } }); }
    };
    new MutationObserver(hook).observe(askBox, { childList: true });
    hook();
  }
  const pick = document.getElementById('pickQ');
  void pick; // the question chips take no beam: a glow clipped by their row looked like a rendering glitch
});
