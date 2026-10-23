import { getSettings, listMeetings, llmReady } from './store.js';
import { parseDictionary } from './dictionary.js';
import { modelLabel } from './llm.js';
import { mountAsk } from './askui.js';
import { filterByScope, describeScope } from './askscope.js';

const $ = (id) => document.getElementById(id);

// What the selector currently says to search.
const scope = { mode: 'all', days: 0, from: '', to: '', ids: [] };
let everything = [];
const picked = new Set(); // ticked meetings stay ticked while the list is filtered by title

function readScope() {
  const v = $('scope').value;
  scope.mode = v === 'all' ? 'all' : v === 'range' ? 'range' : v === 'pick' ? 'pick' : 'days';
  scope.days = Number(v) || 0;
  scope.from = $('dateFrom').value;
  scope.to = $('dateTo').value;
  scope.ids = [...picked];
  return scope;
}

async function scoped() {
  everything = (await listMeetings()).filter((m) => m.segments?.length || m.mom);
  return filterByScope(everything, readScope());
}

const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function renderPick() {
  const q = $('pickQ').value.trim().toLowerCase();
  const shown = [...everything].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).filter((m) => !q || String(m.title || '').toLowerCase().includes(q));
  $('pickList').replaceChildren(
    ...(shown.length
      ? shown.map((m) => {
          const label = document.createElement('label');
          const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value: m.id, checked: picked.has(m.id) });
          const t = document.createElement('span');
          t.className = 't';
          t.textContent = m.title || 'Untitled meeting';
          const meta = document.createElement('span');
          meta.className = 'm';
          meta.textContent = `${fmtDay(m.startedAt)}${m.endedAt ? ` · ${Math.round((m.endedAt - m.startedAt) / 60000)} min` : ''}`;
          t.append(meta);
          label.append(cb, t);
          cb.onchange = () => {
            cb.checked ? picked.add(m.id) : picked.delete(m.id);
            refresh();
          };
          return label;
        })
      : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No meeting matches.' })])
  );
}

// Seconds of speech on record for a meeting: its length, or the last line's time when it never got an end time.
const seconds = (m) => (m.endedAt ? (m.endedAt - m.startedAt) / 1000 : Math.max(0, ...(m.segments || []).map((s) => s.t || 0)));
const span = (sec) => {
  const min = Math.round(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};

(async () => {
  const settings = await getSettings();
  if (llmReady(settings)) $('modelName').textContent = modelLabel(settings);
  const refresh = async () => {
    const list = await scoped();
    if (scope.mode === 'pick' && !$('pickList').children.length) renderPick();
    const n = list.length;
    const total = list.reduce((a, m) => a + seconds(m), 0);
    $('count').textContent = `${n} meeting${n === 1 ? '' : 's'}${total >= 60 ? `, ${span(total)} of transcript` : ''}${scope.mode === 'all' ? '' : ` · ${describeScope(scope)}`}${scope.mode === 'pick' && !n ? ' · tick the meetings to search' : ''}`;
  };
  const onScope = async () => {
    const v = $('scope').value;
    $('rangeBox').hidden = v !== 'range';
    $('pickBox').hidden = v !== 'pick';
    await refresh();
    if (v === 'pick') renderPick();
  };
  $('scope').onchange = onScope;
  $('dateFrom').onchange = $('dateTo').onchange = refresh;
  $('pickQ').oninput = renderPick;
  $('pickAll').onclick = () => {
    document.querySelectorAll('#pickList input').forEach((c) => {
      c.checked = true;
      picked.add(c.value);
    });
    refresh();
  };
  $('pickNone').onclick = () => {
    document.querySelectorAll('#pickList input').forEach((c) => (c.checked = false));
    picked.clear();
    refresh();
  };
  await refresh();
  mountAsk($('askBox'), {
    large: true,
    getMeetings: scoped,
    getCtx: () => ({ entries: parseDictionary(settings.dictionary), attendees: [], learned: (settings.learnedNames || []).slice(-40), myName: settings.myName }),
    openLink: true,
    placeholder: 'e.g. "What did we decide about the budget?"',
    suggestions: ['What action items are still open?', 'What did we decide about the budget?', 'Which risks came up recently?', 'Who agreed to do what this week?'],
  });
})();
