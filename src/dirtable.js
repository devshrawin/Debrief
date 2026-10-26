// The people directory as a table. The setting is still stored as text, one person per line
// ("Name | Title | Department | Designation | Organisation | Chair"), because the minutes writer reads that; this editor shows it
// as rows and writes the text back into the hidden textarea, so saving, Undo and the rest of Settings work unchanged.
const COLS = [
  { key: 'name', label: 'Name', ph: 'Suresh K.', cls: 'c-name' },
  { key: 'title', label: 'Title', ph: 'Sri.', cls: 'c-title' },
  { key: 'dept', label: 'Department', ph: 'Transport', cls: 'c-dept' },
  { key: 'desig', label: 'Designation', ph: 'Joint Secretary', cls: 'c-desig' },
  { key: 'org', label: 'Organisation', ph: 'Metro', cls: 'c-org' },
];

export function parseRows(text) {
  const rows = [];
  const notes = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      notes.push(line); // comment lines are kept, at the top, when the table writes the text back
      continue;
    }
    const p = line.split('|').map((x) => x.trim());
    rows.push({ name: p[0] || '', title: p[1] || '', dept: p[2] || '', desig: p[3] || '', org: p[4] || '', chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || '') });
  }
  return { rows, notes };
}

export function rowsToText(rows, notes = []) {
  const lines = rows
    .filter((r) => r.name.trim())
    .map((r) => [r.name, r.title, r.dept, r.desig, r.org].map((x) => x.trim().replace(/\|/g, '/')).join(' | ') + (r.chair ? ' | Chair' : ''));
  return [...notes, ...lines].join('\n');
}

// Pasted from a spreadsheet: tab separated cells, one person per line (the pipe format works too).
export function parsePasted(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const p = l.split(l.includes('\t') ? '\t' : '|').map((x) => x.trim());
      return { name: p[0] || '', title: p[1] || '', dept: p[2] || '', desig: p[3] || '', org: p[4] || '', chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || '') };
    });
}

export function mountDirectoryTable(textarea, host) {
  if (!textarea || !host) return;
  let rows = [];
  let notes = [];
  const emit = () => {
    textarea.value = rowsToText(rows, notes);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); // marks Settings as changed
  };
  const make = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e[k] = v;
      else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.filter((x) => x != null));
    return e;
  };

  function draw(focus) {
    host.replaceChildren();
    const head = make('div', { class: 'dir-row dir-head', role: 'row' }, ...COLS.map((c) => make('span', { class: `dir-h ${c.cls}`, role: 'columnheader' }, c.label)), make('span', { class: 'dir-h c-chair', role: 'columnheader' }, 'Chair'), make('span', { class: 'c-x' }));
    const body = make('div', { class: 'dir-body', role: 'rowgroup' });
    rows.forEach((r, ri) => {
      const cells = COLS.map((c) => {
        const input = make('input', { class: `dir-in ${c.cls}`, type: 'text', value: r[c.key], placeholder: ri === 0 ? c.ph : '', 'aria-label': `${c.label}, person ${ri + 1}`, autocomplete: 'off', maxlength: 80 });
        input.addEventListener('input', () => {
          r[c.key] = input.value;
          emit();
        });
        input.addEventListener('paste', (e) => {
          const text = e.clipboardData?.getData('text') || '';
          if (!/[\t\n]/.test(text.trim())) return; // a plain word pastes as usual
          e.preventDefault();
          const got = parsePasted(text);
          rows.splice(ri, 1, ...got);
          emit();
          draw();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            rows.splice(ri + 1, 0, blank());
            emit();
            draw(`${ri + 1}.${c.key}`);
          }
        });
        input.dataset.key = `${ri}.${c.key}`;
        return input;
      });
      const chair = make('input', { class: 'dir-chair c-chair', type: 'checkbox', 'aria-label': `${r.name || `Person ${ri + 1}`} is the usual chairperson` });
      chair.checked = !!r.chair;
      chair.addEventListener('change', () => {
        rows.forEach((x, i) => (x.chair = i === ri ? chair.checked : x.chair)); // more than one chair is allowed: different meetings
        r.chair = chair.checked;
        emit();
      });
      const del = make('button', { class: 'dir-x c-x', type: 'button', title: 'Remove this person', 'aria-label': `Remove ${r.name || `person ${ri + 1}`}` }, '×');
      del.addEventListener('click', () => {
        rows.splice(ri, 1);
        emit();
        draw();
      });
      body.append(make('div', { class: 'dir-row', role: 'row' }, ...cells, chair, del));
    });
    const add = make('button', { class: 'btn sm dir-add', type: 'button' }, '+ Add a person');
    add.addEventListener('click', () => {
      rows.push(blank());
      draw(`${rows.length - 1}.name`);
    });
    host.append(make('div', { class: 'dir-table', role: 'table', 'aria-label': 'People directory' }, head, body), make('div', { class: 'dir-foot' }, add, make('span', { class: 'hint' }, 'Tip: paste rows from a spreadsheet (Name, Title, Department, Designation, Organisation) into any name cell.')));
    if (focus) host.querySelector(`[data-key="${focus}"]`)?.focus();
  }
  const blank = () => ({ name: '', title: '', dept: '', desig: '', org: '', chair: false });
  const load = () => {
    const parsed = parseRows(textarea.value);
    rows = parsed.rows;
    notes = parsed.notes;
    if (!rows.length) rows = [blank()];
    draw();
  };
  textarea.hidden = true;
  textarea.addEventListener('dir-refresh', load); // Settings fills the textarea (page load, Undo) and tells the table
  load();
}
