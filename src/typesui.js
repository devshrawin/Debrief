// Settings > Minutes > Meeting types: one card per type, edited in place. value() is the list to store, set(list) loads it.
import { normalizeTypes, DEFAULT_COLUMNS } from './meetingtypes.js';

export function mountMeetingTypes(host, addButton) {
  if (!host || !addButton) return { value: () => [], set() {} };
  let list = [];
  const make = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.filter((x) => x != null));
    return e;
  };
  const changed = () => host.dispatchEvent(new Event('input', { bubbles: true })); // Settings notices unsaved changes
  let seq = 0;
  function field(t, key, label, { hint, area, ph } = {}) {
    const id = `mt-${t.uid}-${key}`;
    const input = make(area ? 'textarea' : 'input', { id, type: area ? null : 'text', rows: area ? 3 : null, spellcheck: 'false', placeholder: ph || '' });
    input.value = key === 'columns' ? (Array.isArray(t.columns) ? t.columns.join(', ') : t.columns || '') : t[key] || '';
    input.addEventListener('input', () => {
      t[key] = input.value;
    });
    return make('div', { class: 'fld' }, make('label', { for: id }, label), input, hint ? make('p', { class: 'hint' }, hint) : null);
  }
  function draw() {
    host.replaceChildren();
    if (!list.length) host.append(make('p', { class: 'hint mt-empty' }, 'No meeting types yet. Add one to give a recurring meeting its own sections.'));
    list.forEach((t, i) => {
      const sw = make('input', { id: `mt-${t.uid}-updates`, type: 'checkbox' });
      sw.checked = t.updates !== false;
      sw.addEventListener('change', () => {
        t.updates = sw.checked;
        cols.hidden = !sw.checked;
        changed();
      });
      const cols = field(t, 'columns', 'Columns of the table', { hint: 'Up to five, comma separated. Each person gets one row, one cell per column.', ph: DEFAULT_COLUMNS.join(', ') });
      cols.hidden = !sw.checked;
      const rm = make('button', { class: 'btn sm', type: 'button', 'aria-label': `Remove meeting type ${t.name || i + 1}` }, 'Remove');
      rm.addEventListener('click', () => {
        list.splice(i, 1);
        draw();
        changed();
      });
      host.append(
        make(
          'div',
          { class: 'mt-card', role: 'group', 'aria-label': t.name || `Meeting type ${i + 1}` },
          field(t, 'name', 'Name', { ph: 'Daily cadence call' }),
          make('div', { class: 'fgrid' }, field(t, 'match', 'Applies when the title contains', { hint: 'Words, comma separated. Any one is enough; capitals do not matter.', ph: 'cadence call, stand-up' }), field(t, 'code', 'Or when the Meet code is', { hint: 'Like abc-defg-hij. Optional.', ph: 'abc-defg-hij' })),
          make('div', { class: 'row-sw' }, sw, make('label', { for: `mt-${t.uid}-updates` }, 'Add an "Updates by person" table (who did what, who plans what)')),
          cols,
          field(t, 'extra', 'Extra instructions for the writer (optional)', { area: true, hint: 'For example: "Write names in English", or "Always note who is on leave".', ph: '' }),
          make('div', { class: 'btnrow' }, rm)
        )
      );
    });
  }
  addButton.addEventListener('click', () => {
    list.push({ uid: ++seq, id: '', name: '', match: '', code: '', updates: true, columns: [...DEFAULT_COLUMNS], extra: '' });
    draw();
    host.querySelector('.mt-card:last-child input')?.focus();
    changed();
  });
  return {
    value() {
      return normalizeTypes(list);
    },
    set(next) {
      list = normalizeTypes(next).map((t) => ({ ...t, uid: ++seq }));
      draw();
    },
  };
}
