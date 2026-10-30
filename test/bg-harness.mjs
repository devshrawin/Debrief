// Runs the real service worker (src/background.js) against an in-memory fake of the chrome API.
const mem = { local: {}, session: {} };
const listeners = { message: [], tabsUpdated: [], tabsRemoved: [], command: [], installed: [] };
const created = [];
const notes = []; // notifications the worker asked for
const area = (name) => ({
  get: async (keys) => {
    const store = mem[name];
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
  },
  set: async (o) => Object.assign(mem[name], JSON.parse(JSON.stringify(o))),
  remove: async (k) => [].concat(k).forEach((x) => delete mem[name][x]),
});
const badge = {};
const title = {};
const icon = {};
const offLog = [];
const winState = {};
const winLog = [];
globalThis.chrome = {
  runtime: {
    id: 'testid',
    getURL: (p) => `chrome-extension://testid/${p}`,
    onInstalled: { addListener: (f) => listeners.installed.push(f) },
    onMessage: { addListener: (f) => listeners.message.push(f) },
    sendMessage: async (m) => (m.target === 'offscreen' && offLog.push(m), m.target === 'offscreen' ? (m.type === 'start' ? { ok: true, mic: true } : { ok: true, micOn: m.on }) : undefined),
    getContexts: async () => [],
    openOptionsPage: () => {},
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async (id) => ({ id, state: winState[id] || 'normal' }), update: async (id, o) => { winState[id] = o.state; winLog.push([id, o.state]); } },
  storage: { local: area('local'), session: area('session'), onChanged: { addListener: () => {} } },
  action: { onClicked: { addListener: () => {} }, setPopup: async () => {}, openPopup: async () => {}, setBadgeText: (o) => ((badge[o.tabId ?? 'g'] = o.text), Promise.resolve()), setBadgeBackgroundColor: () => Promise.resolve(), setTitle: (o) => ((title[o.tabId ?? 'g'] = o.title), Promise.resolve()), setIcon: (o) => ((icon[o.tabId ?? 'g'] = o.path[16]), Promise.resolve()) },
  tabs: { create: async (o) => created.push(o), onActivated: { addListener: () => {} }, get: async (id) => ({ id, url: 'https://meet.google.com/abc-defg-hij' }), onUpdated: { addListener: (f) => listeners.tabsUpdated.push(f) }, onRemoved: { addListener: (f) => listeners.tabsRemoved.push(f) }, query: async () => [] },
  commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  notifications: { create: (id, o, cb) => (notes.push({ id, ...o }), cb?.(id)) },
  scripting: { executeScript: async () => {} },
  tabCapture: { getMediaStreamId: async () => 'sid' },
};
await import('../src/background.js');

export const state = { mem, created, notes, badge, title, icon, offLog, winState, winLog };
// Sends a message the way Chrome would and waits for the reply (or reports that none came).
export function send(msg, sender = { id: 'testid', tab: { id: 7 }, url: 'chrome-extension://testid/popup.html' }) {
  return new Promise((resolve) => {
    let replied = false;
    let keep = false;
    for (const l of listeners.message) {
      const r = l({ target: 'bg', ...msg }, sender, (x) => ((replied = true), resolve(x)));
      if (r === true) keep = true;
    }
    if (!keep && !replied) resolve('NO-HANDLER');
    else setTimeout(() => !replied && resolve('TIMEOUT'), 1500);
  });
}
