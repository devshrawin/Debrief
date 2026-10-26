// The floating glass panel: the popup, opened on top of the web page instead of in Chrome's own popup window. Chrome draws
// its popup as a separate opaque window that nothing can see through; this panel lives in the page, so the page really
// shows through the frosted glass. Injected by the service worker when the toolbar button is pressed (activeTab).
// Pressing the button again, Esc, or a click on the page closes it. If the page does not allow it, the service worker
// opens the ordinary popup instead.
(() => {
  const ID = 'debrief-panel-host';
  const old = document.getElementById(ID);
  if (old) {
    old.__close?.();
    return;
  }

  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all: initial; position: fixed; top: 8px; right: 12px; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.title = 'Debrief';
  frame.src = chrome.runtime.getURL('popup.html');
  frame.allow = 'microphone';
  const box = document.createElement('div');
  box.className = 'box';
  box.append(frame);
  const css = document.createElement('style');
  root.append(css, box);

  const paint = (ui) => {
    const dark = ui.uiTheme === 'dark' || (ui.uiTheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const solid = !!ui.uiSolid;
    const tint = solid ? (dark ? 'rgb(28 28 36)' : 'rgb(246 246 250)') : dark ? 'rgb(24 24 34 / .5)' : 'rgb(255 255 255 / .5)';
    css.textContent = `
      .box { position: relative; width: 360px; max-width: calc(100vw - 24px); height: 460px; max-height: calc(100vh - 24px); border-radius: 18px; overflow: hidden;
        background: ${tint}; ${solid ? '' : '-webkit-backdrop-filter: blur(32px) saturate(1.4); backdrop-filter: blur(32px) saturate(1.4);'}
        box-shadow: 0 0 0 .5px ${dark ? 'rgb(255 255 255 / .22)' : 'rgb(255 255 255 / .8)'}, inset 0 1px 0 ${dark ? 'rgb(255 255 255 / .14)' : 'rgb(255 255 255 / .9)'}, 0 18px 50px rgb(0 0 0 / ${dark ? '.55' : '.28'});
        animation: in .18s cubic-bezier(.2, .8, .2, 1); transform-origin: top right; }
      iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: ${dark ? 'dark' : 'light'}; }
      @keyframes in { from { opacity: 0; transform: translateY(-6px) scale(.97); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .box { animation: none; } }`;
  };
  paint({});
  try {
    chrome.storage.local.get(['uiTheme', 'uiSolid']).then(paint);
  } catch {}

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    removeEventListener('message', onMessage);
    removeEventListener('pointerdown', onOutside, true);
    removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
    host.remove();
  };
  host.__close = close;

  let ready = false;
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow || !e.data?.debriefPanel) return;
    if (e.data.type === 'ready') ready = true;
    else if (e.data.type === 'close') close();
    else if (e.data.type === 'size' && e.data.h > 0) box.style.height = `${e.data.h}px`;
  };
  const onOutside = (e) => {
    if (!e.composedPath().includes(host)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  addEventListener('message', onMessage);
  addEventListener('pointerdown', onOutside, true);
  addEventListener('keydown', onKey, true);

  // a page whose security policy forbids the frame: give up quickly and let the service worker open the plain popup
  const timer = setTimeout(() => {
    if (ready) return;
    close();
    chrome.runtime.sendMessage({ target: 'bg', type: 'panel-failed' }).catch(() => {});
  }, 2500);

  document.documentElement.append(host);
})();
