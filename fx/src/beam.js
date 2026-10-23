// Vanilla driver for border-beam. The CSS is generated at build time
// (extension/fx/beam.css); this file only toggles the attributes the
// library's React component would set, and registers pulse beams with the
// library's own shared ~30 fps breathing loop (pulseDriver.ts, unchanged).
import { registerPulseInstance } from '../../third_party/libraries-dev/border-beam/src/pulseDriver';
import PULSE from '../generated/beam-pulse.json';

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  || matchMedia('(prefers-reduced-transparency: reduce)').matches
  || document.documentElement.classList.contains('solid');
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

let cssLoaded = false;
/** Load this page's generated beam stylesheet once, off the first-paint path. */
function loadCss() {
  if (cssLoaded) return;
  cssLoaded = true;
  const page = document.documentElement.dataset.page || location.pathname.replace(/^.*\//, '').replace(/\.html$/, '');
  const map = { popup: 'popup', mom: 'mom', options: 'options', welcome: 'welcome', ask: 'ask' };
  const name = map[page];
  if (!name) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = `fx/beam-${name}.css`;
  document.head.append(l);
}

/** Prepare `el` to carry beam `id`. Returns a setter: beamOn(true|false). */
export function beam(el, id, { strength = 1 } = {}) {
  if (!el) return () => {};
  el.setAttribute('data-beam', id);
  el.style.setProperty('--beam-strength', String(strength));
  if (!el.querySelector(':scope > [data-beam-bloom]')) {
    const b = document.createElement('div');
    b.setAttribute('data-beam-bloom', '');
    b.setAttribute('aria-hidden', 'true');
    el.append(b);
  }
  let on = false, unregister = null, io = null, visible = true;
  const syncPulse = () => {
    unregister?.(); unregister = null;
    const cfg = PULSE[id]?.[dark() ? 'dark' : 'light'];
    if (on && cfg && visible && !calm()) unregister = registerPulseInstance(el, cfg);
  };
  io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    el.toggleAttribute('data-paused', on && !visible);
    syncPulse();
  }, { rootMargin: '256px' });
  io.observe(el);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncPulse);
  el.addEventListener('animationend', (e) => {
    if (e.animationName.includes('fade-out')) el.removeAttribute('data-fading');
  });
  return (want) => {
    want = !!want && !calm();
    if (want === on) return;
    if (want) loadCss();
    on = want;
    if (on) { el.removeAttribute('data-fading'); el.setAttribute('data-active', ''); }
    else if (el.hasAttribute('data-active')) { el.removeAttribute('data-active'); el.setAttribute('data-fading', ''); }
    syncPulse();
  };
}
