// The Open actions page: every open action from every meeting, to tick off. Reads only the meetings' small records.
// All text on the page comes from meetings (written by people and models), so it is only ever set as text.
import { openActionsAcrossMeetings, setActionDone } from './jobs.js';
import { listMeetingMetas, getSettings } from './store.js';
import * as L from './actionslogic.js';
import { fmtDay, fmtDue } from './datefmt.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
const MODE_KEY = 'db.actions.mode';
const MODES = ['meeting', 'owner', 'due'];
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const day = fmtDay;

const state = { open: [], done: [], hasItems: false, classic: false, mode: 'meeting', showDone: false, q: '', loaded: false };
try {
  const m = localStorage.getItem(MODE_KEY);
  if (MODES.includes(m)) state.mode = m;
} catch {}

let undoTimer = null;
function announce(text, undo) {
  clearTimeout(undoTimer);
  $('statusText').textContent = text;
  const b = $('undo');
  b.classList.toggle('hidden', !undo);
  b.onclick = undo || null;
  if (text) undoTimer = setTimeout(() => announce(''), undo ? 8000 : 6000);
}

async function load(focusAt) {
  const [open, metas] = await Promise.all([openActionsAcrossMeetings(), listMeetingMetas({ counts: [] })]);
  state.open = open;
  state.hasItems = metas.some((m) => Array.isArray(m.items?.actions));
  state.done = L.recentDone(metas);
  state.loaded = true;
  render(focusAt);
}

function shown() {
  return L.filterActions(state.showDone ? [...state.open, ...state.done] : state.open, state.q);
}

function rowEl(a, mode) {
  const done = a.status === 'done';
  const cb = el('input', { type: 'checkbox', checked: done });
  const text = L.plainInline(a.text);
  const label = el('label', { className: 'ac-tick' }, cb, el('span', { className: 'sr-only', textContent: `${done ? 'Mark not done' : 'Mark done'}: ${text}` }));
  const meta = el('div', { className: 'ac-meta' });
  const bit = (node) => meta.append(node);
  if (mode !== 'owner') bit(el('span', { textContent: `Owner: ${a.owner || 'Not stated'}` }));
  if (a.due) {
    const due = el('span', { className: 'ac-due' }, el('span', { textContent: `Due: ${fmtDue(a.due, a.date)}` }));
    if (a.overdue && !done) due.append(el('span', { className: 'chip warn', textContent: 'Overdue' }));
    bit(due);
  }
  if (done && a.doneAt) bit(el('span', { textContent: `Done ${day(a.doneAt)}` }));
  // the source and the time of the line it came from are one item, so the time never drops onto a line of its own
  const where = el('span', { className: 'ac-where' });
  if (mode !== 'meeting') where.append(el('a', { className: 'ac-src', href: `mom.html?id=${encodeURIComponent(a.meetingId)}#actions`, textContent: [a.title || 'Untitled meeting', day(a.date)].filter(Boolean).join(', ') }));
  if (a.at) where.append(mode !== 'meeting' ? ' ' : '', el('span', { className: 'ac-at', textContent: `[${a.at}]` }));
  if (where.childNodes.length) bit(where);
  const li = el('li', { className: `ac-row${done ? ' is-done' : ''}` }, label, el('div', { className: 'ac-body' }, el('div', { className: 'ac-text', textContent: text }), meta));
  li.dataset.key = `${a.meetingId}/${a.id}`;
  cb.onchange = () => tick(a, cb, li);
  return li;
}

function render(focusAt) {
  const counts = L.countActions(state.open);
  $('counts').textContent = state.loaded ? (counts.open ? `${counts.open} open${counts.overdue ? ` · ${counts.overdue} overdue` : ''}` : state.hasItems ? 'No open actions.' : '') : '';
  $('tools').classList.toggle('hidden', !state.hasItems);
  for (const b of $('modes').querySelectorAll('button')) {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  const list = shown();
  const box = $('list');
  if (!state.hasItems) {
    box.replaceChildren(emptyCard('No actions yet', `Actions appear here after your next meeting's minutes are written.${state.classic ? ' Actions are tracked when minutes are written the structured way (Settings → Minutes).' : ''}`));
    return;
  }
  if (!list.length) {
    box.replaceChildren(emptyCard(state.q.trim() ? 'No actions match' : 'No open actions.', state.q.trim() ? 'Try another name or word.' : ''));
    return;
  }
  const groups = L.groupActions(list, state.mode);
  box.replaceChildren(
    ...groups.map((g, i) => {
      const openN = g.items.filter((a) => a.status !== 'done').length;
      const h = el('h2', { id: `g${i}` });
      if (state.mode === 'meeting') {
        h.append(el('a', { href: `mom.html?id=${encodeURIComponent(g.key)}#actions`, textContent: g.label }));
        if (g.date) h.append(el('span', { className: 'ac-sub', textContent: day(g.date) }));
      } else h.append(g.label);
      h.append(el('span', { className: 'ac-n', textContent: `${openN} open` }));
      const sec = el('section', { className: 'ac-group' }, h, el('ul', { className: 'ac-list' }, ...g.items.map((a) => rowEl(a, state.mode))));
      sec.setAttribute('aria-labelledby', h.id);
      return sec;
    })
  );
  if (focusAt) {
    const rows = [...box.querySelectorAll('.ac-row input')];
    (focusAt.key ? box.querySelector(`.ac-row[data-key="${CSS.escape(focusAt.key)}"] input`) : rows[Math.min(focusAt.index, rows.length - 1)] || $('q'))?.focus();
  }
}

function emptyCard(title, text) {
  return el('div', { className: 'ac-empty' }, el('strong', { textContent: title }), text ? el('p', { className: 'hint', textContent: text }) : null);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function tick(a, cb, li) {
  const want = cb.checked;
  cb.disabled = true;
  try {
    if (!(await setActionDone(a.meetingId, a.id, want))) throw new Error('this action is no longer in its meeting');
  } catch (e) {
    cb.checked = !want;
    cb.disabled = false;
    announce(`Could not save the change: ${e.message}`);
    return;
  }
  const rows = [...document.querySelectorAll('#list .ac-row')];
  const index = rows.indexOf(li);
  const leaving = want && !state.showDone;
  if (leaving && !reduceMotion()) {
    li.classList.add('leaving');
    await wait(220);
  }
  // the row may be gone: the keyboard carries on from the next one
  await load(leaving ? { index } : { key: `${a.meetingId}/${a.id}` });
  announce(want ? `Marked done: ${L.plainInline(a.text)}` : `Reopened: ${L.plainInline(a.text)}`, want ? async () => {
    try {
      await setActionDone(a.meetingId, a.id, false);
      await load();
      announce(`Reopened: ${L.plainInline(a.text)}`);
    } catch (e) {
      announce(`Could not undo: ${e.message}`);
    }
  } : null);
}

for (const b of $('modes').querySelectorAll('button')) {
  b.onclick = () => {
    state.mode = b.dataset.mode;
    try {
      localStorage.setItem(MODE_KEY, state.mode);
    } catch {}
    render();
  };
}
$('q').oninput = () => {
  state.q = $('q').value;
  render();
  const n = shown().length;
  if (state.q.trim()) $('counts').textContent = `${n} match${n === 1 ? '' : 'es'} for “${state.q.trim()}”`;
};
$('showDone').onchange = () => {
  state.showDone = $('showDone').checked;
  render();
};
// coming back to the tab: another page may have ticked something
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && state.loaded && load().catch(() => {}));

(async () => {
  try {
    state.classic = (await getSettings()).minutesEngine === 'classic';
  } catch {}
  try {
    await load();
  } catch (e) {
    $('list').replaceChildren(emptyCard('Actions could not be read', e.message));
  }
})();
