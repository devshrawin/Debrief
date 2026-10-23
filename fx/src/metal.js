// Liquid-metal accents, loaded lazily (after first paint) and only on pages
// that use them. Wraps metal-fx's React-free engine: one shared WebGL2
// context per page, ~15 fps, paused on hidden tabs and offscreen.
// Not ported: cursor light / cursor sprites and proximity reflections.
// Without WebGL2, or when the user prefers reduced motion or transparency,
// nothing is drawn and the plain element shows.
import { createInstance, destroyInstance, updateInstance, setSharedPreset } from '../../third_party/libraries-dev/metal-fx/src/engine/renderer/loop';
import { isMetalFxSupported } from '../../third_party/libraries-dev/metal-fx/src/engine/renderer/core';
import { paintTextRun } from '../../third_party/libraries-dev/metal-fx/src/engine/textMask';

const off = () => !isMetalFxSupported()
  || matchMedia('(prefers-reduced-transparency: reduce)').matches
  || matchMedia('(forced-colors: active)').matches
  || document.documentElement.classList.contains('solid');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const theme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
let presetSet = false;

function mount(host, { kind = 'pill', ring = 1.5, mask = null, strength = 1, z = 0, onFirstCopy } = {}) {
  if (off() || !host) return null;
  if (!presetSet) {
    setSharedPreset('silver', theme());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setSharedPreset('silver', theme()));
    presetSet = true;
  }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'metal-canvas';
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:inherit;z-index:${z}`;
  host.append(canvas);
  const r = host.getBoundingClientRect();
  const radius = Math.min(parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0, r.height / 2);
  const inst = createInstance({
    hostCanvas: canvas, cssWidth: Math.max(1, Math.round(r.width)), cssHeight: Math.max(1, Math.round(r.height)),
    cornerRadius: radius, kind, ringCssPx: ring, opacityMul: strength, paused: reduced(), mask, onFirstCopy,
  });
  const ro = new ResizeObserver(() => {
    const b = host.getBoundingClientRect();
    updateInstance(inst, { cssWidth: Math.max(1, Math.round(b.width)), cssHeight: Math.max(1, Math.round(b.height)) });
  });
  ro.observe(host);
  return { destroy() { ro.disconnect(); destroyInstance(inst); canvas.remove(); }, pause(p) { updateInstance(inst, { paused: p || reduced() }); } };
}

/** A thin liquid-metal ring around a button or badge. */
export function ring(host, opts) { return mount(host, { ...opts, z: 0 }); }

/** Metal inside the glyphs of a short word (the wordmark). */
export function text(host, textEl, opts = {}) {
  return mount(host, { ...opts, z: 2, ring: 0, mask: (ctx, _w, _h, dpr) => paintTextRun(ctx, host, textEl, dpr),
    onFirstCopy: () => { textEl.style.webkitTextFillColor = 'transparent'; } });
}

window.DebriefMetal = { ring, text };
document.dispatchEvent(new Event('debrief-metal-ready'));
