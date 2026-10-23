// <db-orb state="composing" size="20" label="Writing the minutes…">
// A vanilla port of thinking-orbs' <ThinkingOrb>, built on the library's own
// React-free engine (thinking-orbs/engine). Keeps the library's behaviour:
// one shared clock, DPR capped at 2, paused offscreen and on hidden tabs,
// a single static frame under prefers-reduced-motion, role="img" + label.
// The cursor "gravity" effect is deliberately not ported.
import { resolvePreset, MODE_FRAMES, paintFrame } from '../../third_party/libraries-dev/thinking-orbs/src/engine/index';

const LABELS = {
  working: 'Working…', searching: 'Searching…', solving: 'Solving…', listening: 'Listening…',
  connecting: 'Connecting…', weaving: 'Weaving…', composing: 'Composing…', breathing: 'Waiting…', shaping: 'Checking…',
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkMq = matchMedia('(prefers-color-scheme: dark)');
// Appearance: an explicit theme wins over the system; "animated effects off" holds the orbs still
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : darkMq.matches);
const still = () => reduceMotion.matches || document.documentElement.classList.contains('fx-off');

class DbOrb extends HTMLElement {
  static get observedAttributes() { return ['state', 'size', 'label']; }
  constructor() {
    super();
    this._canvas = document.createElement('canvas');
    this._canvas.setAttribute('role', 'img');
    this._canvas.style.display = 'block';
    this._raf = 0; this._running = false; this._visible = true;
    this._loop = () => { this._frame(performance.now() / 1000); if (this._running) this._raf = requestAnimationFrame(this._loop); };
    this._onVis = () => this._sync();
    this._onTheme = () => this._setup();
  }
  connectedCallback() {
    if (!this._canvas.isConnected) this.append(this._canvas);
    this._io = new IntersectionObserver(([e]) => { this._visible = e.isIntersecting; this._sync(); });
    this._io.observe(this);
    document.addEventListener('visibilitychange', this._onVis);
    document.addEventListener('db-fx-change', this._onTheme);
    darkMq.addEventListener('change', this._onTheme);
    reduceMotion.addEventListener('change', this._onTheme);
    this._setup();
  }
  disconnectedCallback() {
    this._stop(); this._io?.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    document.removeEventListener('db-fx-change', this._onTheme);
    darkMq.removeEventListener('change', this._onTheme);
    reduceMotion.removeEventListener('change', this._onTheme);
  }
  attributeChangedCallback() { if (this.isConnected) this._setup(); }
  _setup() {
    const state = this.getAttribute('state') || 'working';
    const size = Number(this.getAttribute('size')) === 64 ? 64 : 20;
    this._canvas.setAttribute('aria-label', this.getAttribute('label') || LABELS[state] || 'Working…');
    const dpr = Math.min(2, devicePixelRatio || 1);
    this._canvas.width = Math.round(size * dpr); this._canvas.height = Math.round(size * dpr);
    this._canvas.style.width = this._canvas.style.height = size + 'px';
    this._ctx = this._canvas.getContext('2d');
    const { mode, speed, opts } = resolvePreset(state, size);
    this._size = size; this._dpr = dpr; this._speed = speed; this._opts = opts; this._fn = MODE_FRAMES[mode];
    this._frame(performance.now() / 1000);
    this._sync();
  }
  _frame(tSec) {
    if (!this._ctx || !this._fn) return;
    const ctx = this._ctx, s = this._size;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    // Orbs ink in the label colour: dark dots on light surfaces, light on dark.
    paintFrame(ctx, this._fn(s, still() ? 0.6 : tSec * this._speed, this._opts), isDark());
  }
  _sync() {
    const want = this._visible && document.visibilityState !== 'hidden' && !still();
    if (want && !this._running) { this._running = true; this._raf = requestAnimationFrame(this._loop); }
    else if (!want) this._stop();
  }
  _stop() { this._running = false; cancelAnimationFrame(this._raf); }
}
if (!customElements.get('db-orb')) customElements.define('db-orb', DbOrb);

export function makeOrb(state, size = 20, label) {
  const o = document.createElement('db-orb');
  o.setAttribute('state', state); o.setAttribute('size', String(size));
  if (label) o.setAttribute('label', label);
  return o;
}
