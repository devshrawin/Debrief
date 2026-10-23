// Loaded first on every page (sync, in <head>, ~1.5 KB).
// 1. Applies the in-app "Reduce transparency" choice before paint (own storage key: uiSolid).
// 2. Draws the fluid colour layer behind the glass: six soft blobs that drift and cross-fade (CSS only, see style.css).
// 3. After the first frame has painted, switches on backdrop blur (html.glass) and loads this page's effects script,
//    so effects never delay opening.
const html = document.documentElement;
try { if (localStorage.getItem('db.solid') === '1') html.classList.add('solid'); } catch {}
const apply = (on) => {
  html.classList.toggle('solid', !!on);
  try { localStorage.setItem('db.solid', on ? '1' : '0'); } catch {}
};
try {
  chrome.storage?.local.get('uiSolid').then((r) => apply(r.uiSolid));
  chrome.storage?.onChanged.addListener((c, area) => { if (area === 'local' && 'uiSolid' in c) apply(c.uiSolid.newValue); });
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
