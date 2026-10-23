// Shared helpers for the page enhancers. They never change what the page
// does; they only read state the existing scripts already put in the DOM
// (classes, status text) and add motion and material on top.
import { makeOrb } from './orb.js';
import { beam } from './beam.js';
import { gooSegmented } from './goo.js';
export { makeOrb, beam, gooSegmented };

/** Map status text to a thinking-orbs state. Order matters: first match wins. */
export const ORB_RULES = [
  [/^(done|stopped|failed|could not|nothing|set up|saved|sent|emailed|ok|works|working ✓)/i, null],
  [/reading the transcript/i, 'searching'],
  [/checking nothing was left out/i, 'shaping'],
  [/writing|composing|answering/i, 'composing'],
  [/searching/i, 'searching'],
  [/failed during the meeting|transcribing \d+ audio piece|recover/i, 'solving'],
  [/transcrib/i, 'working'],
  [/sending|emailing|sharing|connecting|testing|checking/i, 'connecting'],
  [/retrying|trying again|busy|waiting|countdown|in \d+ s/i, 'breathing'],
  [/finishing/i, 'working'],
];
export function orbStateFor(text) {
  const t = (text || '').trim();
  if (!t || !/…|\.\.\.$/.test(t)) return null; // only work in progress ends with an ellipsis
  for (const [re, state] of ORB_RULES) if (re.test(t)) return state;
  return 'working';
}

/** Put a live orb in front of a status element while its text says work is in progress. */
export function orbForStatus(statusEl, { size = 20, onChange } = {}) {
  if (!statusEl) return;
  statusEl.setAttribute('aria-live', 'polite');
  let orb = null;
  const sync = () => {
    const state = orbStateFor(statusEl.textContent);
    if (state) {
      if (!orb) { orb = makeOrb(state, size); orb.classList.add('status-orb'); statusEl.before(orb); }
      else if (orb.getAttribute('state') !== state) orb.setAttribute('state', state);
      orb.setAttribute('label', statusEl.textContent.trim());
    } else if (orb) { orb.remove(); orb = null; }
    onChange?.(state);
  };
  new MutationObserver(sync).observe(statusEl, { childList: true, characterData: true, subtree: true });
  sync();
}

/** Every spinner (.spin) becomes a thinking orb, including ones the page adds later. The state follows the words next to it. */
export function orbifySpinners(root = document.body) {
  if (!root) return;
  const swap = (sp) => {
    if (sp.dataset.orbed) return;
    sp.dataset.orbed = '1';
    const text = (sp.parentElement?.textContent || '').trim();
    const orb = makeOrb(orbStateFor(text.endsWith('…') ? text : text + '…') || 'working', 20, text || undefined);
    orb.classList.add('status-orb');
    sp.replaceWith(orb);
  };
  const scan = () => root.querySelectorAll('.spin:not([data-orbed])').forEach(swap);
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  scan();
}

/** A search or question field gets the border beam while it has focus, or while an answer is being found.
 *  `host` carries the beam (any element with a radius); `busy()` can add more reasons to glow. */
export function searchBeam(host, { id = 'db-search', strength = 0.85, busy = () => false } = {}) {
  if (!host) return () => {};
  host.classList.add('search-beam');
  const set = beam(host, id, { strength });
  const sync = () => set(host.contains(document.activeElement) || !!busy());
  host.addEventListener('focusin', sync);
  host.addEventListener('focusout', () => setTimeout(sync, 0));
  return sync;
}

/** Load the metal bundle after first paint; call `fn(DebriefMetal)` when ready. */
export function withMetal(fn) {
  const go = () => window.DebriefMetal && fn(window.DebriefMetal);
  if (window.DebriefMetal) return go();
  document.addEventListener('debrief-metal-ready', go, { once: true });
  const load = () => {
    if (document.getElementById('db-metal-js')) return;
    const s = document.createElement('script');
    s.id = 'db-metal-js'; s.src = 'fx/metal.js'; s.async = true;
    document.head.append(s);
  };
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 1200 }); else setTimeout(load, 300);
}

/** Run once the DOM is ready (fx scripts are loaded after the page's own script). */
export function ready(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn();
}

/** Watch an element's class list; call fn(el) on every change and once now. */
export function onClass(el, fn) {
  if (!el) return;
  new MutationObserver(() => fn(el)).observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
  fn(el);
}

/** Attach status orbs (and, for tests, the "db-test" beam on the enclosing card)
 *  to every element matching `selector` under `root`, including ones that
 *  the page's own script adds later. */
export function watchStatuses(root, selector, { beamId = 'db-test' } = {}) {
  if (!root) return;
  const seen = new WeakSet();
  const hook = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const card = el.closest('.card');
    let setBeam = null;
    orbForStatus(el, {
      onChange: (state) => {
        if (!card || !beamId) return;
        if (!setBeam && state === 'connecting') setBeam = beam(card, beamId, { strength: 0.8 });
        setBeam?.(state === 'connecting');
      },
    });
  };
  const scan = () => root.querySelectorAll(selector).forEach(hook);
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  scan();
}
