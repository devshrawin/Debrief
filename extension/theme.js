// Loaded first on every page (sync, in <head>). Applies the Colour choice (auto / light / dark) before the first paint.
// The choice lives in chrome.storage.local as uiTheme and is mirrored in localStorage so the first frame is already right.
// With no choice the page follows the system setting (style.css).
(() => {
  const html = document.documentElement;
  if (window.top !== window) html.classList.add('in-panel'); // the popup inside the floating panel
  const set = (v) => { if (v === 'light' || v === 'dark') html.dataset.theme = v; else delete html.dataset.theme; };
  try { set(localStorage.getItem('db.theme')); } catch {}
  try {
    chrome.storage?.local.get('uiTheme').then((r) => { set(r.uiTheme); try { localStorage.setItem('db.theme', r.uiTheme || ''); } catch {} });
    chrome.storage?.onChanged.addListener((c, area) => {
      if (area !== 'local' || !c.uiTheme) return;
      set(c.uiTheme.newValue);
      try { localStorage.setItem('db.theme', c.uiTheme.newValue || ''); } catch {}
    });
  } catch {}
})();
