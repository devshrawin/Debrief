// Loaded first on every page (sync, in <head>). Applies the theme choice (auto / light / dark) before the first paint.
// The choice lives in chrome.storage.local (uiTheme) and is mirrored in localStorage so the first frame is already right.
const html = document.documentElement;
const read = () => { try { return JSON.parse(localStorage.getItem('db.ui') || '{}'); } catch { return {}; } };
const apply = (ui) => {
  if (ui.uiTheme === 'light' || ui.uiTheme === 'dark') html.dataset.theme = ui.uiTheme; else delete html.dataset.theme;
  try { localStorage.setItem('db.ui', JSON.stringify(ui)); } catch {}
};
let ui = read();
apply(ui);
try {
  chrome.storage?.local.get(['uiTheme']).then((r) => { ui = { ...ui, ...r }; apply(ui); });
  chrome.storage?.onChanged.addListener((c, area) => {
    if (area !== 'local' || !('uiTheme' in c)) return;
    ui = { ...ui, uiTheme: c.uiTheme.newValue };
    apply(ui);
  });
} catch {}
html.dataset.page = location.pathname.replace(/^.*\//, '').replace(/\.html$/, '');
if (new URLSearchParams(location.search).has('side')) html.classList.add('in-side'); // Chrome's side panel
