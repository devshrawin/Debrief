// Loaded first on every page (sync, in <head>, ~2 KB).
// 1. Applies the Appearance choices before paint: theme (auto / light / dark), reduce transparency, moving background
//    (off / calm / lively), animated effects (on / off). They live in chrome.storage.local (uiTheme, uiSolid, uiMotion,
//    uiEffects) and are mirrored in localStorage so the first frame is already right.
// 2. Draws the fluid colour room behind the glass: six soft blobs that drift and cross-fade (CSS only, see style.css).
// 3. After the first frame has painted, switches on backdrop blur (html.glass) and loads this page's effects script,
//    so effects never delay opening.
const html = document.documentElement;
const KEYS = ['uiTheme', 'uiSolid', 'uiMotion', 'uiEffects'];
const read = () => { try { return JSON.parse(localStorage.getItem('db.ui') || '{}'); } catch { return {}; } };
const apply = (ui) => {
  html.classList.toggle('solid', !!ui.uiSolid);
  html.classList.toggle('motion-off', ui.uiMotion === 'off');
  html.classList.toggle('motion-calm', ui.uiMotion === 'calm');
  html.classList.toggle('fx-off', ui.uiEffects === false);
  if (ui.uiTheme === 'light' || ui.uiTheme === 'dark') html.dataset.theme = ui.uiTheme; else delete html.dataset.theme;
  try { localStorage.setItem('db.ui', JSON.stringify(ui)); } catch {}
  document.dispatchEvent(new Event('db-fx-change'));
};
let ui = read();
apply(ui);
try {
  chrome.storage?.local.get(KEYS).then((r) => { ui = { ...ui, ...r }; apply(ui); });
  chrome.storage?.onChanged.addListener((c, area) => {
    if (area !== 'local' || !KEYS.some((k) => k in c)) return;
    for (const k of KEYS) if (k in c) ui = { ...ui, [k]: c[k].newValue };
    apply(ui);
  });
} catch {}

const PAGES = { popup: 1, mom: 1, options: 1, welcome: 1, ask: 1 };
const page = location.pathname.replace(/^.*\//, '').replace(/\.html$/, '');
html.dataset.page = page;

// the room behind the glass: fixed, behind everything, pointer-events none; stops moving when the tab is hidden
const room = () => {
  if (document.querySelector('.fx-bg')) return;
  const bg = document.createElement('div');
  bg.className = 'fx-bg';
  bg.setAttribute('aria-hidden', 'true');
  bg.innerHTML = '<i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><i class="b5"></i><i class="b6"></i>';
  document.body.prepend(bg);
};
if (document.body) room(); else document.addEventListener('DOMContentLoaded', room, { once: true });
document.addEventListener('visibilitychange', () => html.classList.toggle('paused', document.visibilityState === 'hidden'));

requestAnimationFrame(() => setTimeout(() => {
  html.classList.add('glass');
  if (PAGES[page]) {
    const s = document.createElement('script');
    s.src = `fx/fx-${page}.js`;
    document.head.append(s);
  }
}, 0));
