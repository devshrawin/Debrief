// The people directory as a table. The setting is still stored as text, one person per line
// ("Name | Title | Department | Designation | Organisation | Chair"), because the minutes writer reads that; this editor shows it
// as rows and writes the text back into the hidden textarea, so saving, Undo and the rest of Settings work unchanged.
const COLS = [
  { key: 'name', label: 'Name', ph: 'Suresh K.', cls: 'c-name' },
  { key: 'title', label: 'Title', ph: 'Sri.', cls: 'c-title' },
  { key: 'dept', label: 'Department', ph: 'Transport', cls: 'c-dept' },
  { key: 'desig', label: 'Designation', ph: 'Joint Secretary', cls: 'c-desig' },
  { key: 'org', label: 'Organisation', ph: 'Metro', cls: 'c-org' },
  { key: 'email', label: 'Email', ph: 'suresh@metro.org', cls: 'c-email' },
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
    rows.push({ name: p[0] || '', title: p[1] || '', dept: p[2] || '', desig: p[3] || '', org: p[4] || '', chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || ''), email: /@/.test(p[6] || '') ? p[6] : '' });
  }
  return { rows, notes };
}

export function rowsToText(rows, notes = []) {
  const lines = rows
    .filter((r) => r.name.trim())
    .map((r) => {
      const cells = [r.name, r.title, r.dept, r.desig, r.org].map((x) => String(x || '').trim().replace(/\|/g, '/')).join(' | ');
      const mail = String(r.email || '').trim().replace(/\|/g, '');
      return cells + (r.chair || mail ? ` | ${r.chair ? 'Chair' : ''}` : '') + (mail ? ` | ${mail}` : '');
    });
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
      return { name: p[0] || '', title: p[1] || '', dept: p[2] || '', desig: p[3] || '', org: p[4] || '', chair: /^(chair|chairperson|chairman|yes|y|\*)$/i.test(p[5] || ''), email: /@/.test(p[6] || '') ? p[6] : '' };
    });
}

// The row for this name (any capitalisation), or null.
export const findRow = (rows, name) => rows.find((r) => r.name.trim().toLowerCase() === String(name || '').trim().toLowerCase()) || null;

// Adds or updates the person called `d.name` with the details given (empty details never wipe what is there).
export function upsertRow(rows, d) {
  const name = String(d.name || '').trim();
  if (!name) return rows;
  const row = findRow(rows, name);
  const fields = ['title', 'dept', 'desig', 'org', 'email'];
  if (!row) return [...rows, { name, title: '', dept: '', desig: '', org: '', chair: false, email: '', ...Object.fromEntries(fields.map((k) => [k, String(d[k] || '').trim()])) }];
  for (const k of fields) if (String(d[k] || '').trim()) row[k] = String(d[k]).trim();
  if (typeof d.chair === 'boolean') row.chair = d.chair;
  return rows;
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
    host.append(make('div', { class: 'dir-table', role: 'table', 'aria-label': 'People directory' }, head, body), make('div', { class: 'dir-foot' }, add, make('span', { class: 'hint' }, 'Tip: paste rows from a spreadsheet (Name, Title, Department, Designation, Organisation, Email) into any name cell.')));
    if (focus) host.querySelector(`[data-key="${focus}"]`)?.focus();
  }
  const blank = () => ({ name: '', title: '', dept: '', desig: '', org: '', chair: false, email: '' });
  const load = () => {
    const parsed = parseRows(textarea.value);
    rows = parsed.rows;
    notes = parsed.notes;
    if (!rows.length) rows = [blank()];
    draw();
  };
  textarea.hidden = true;
  textarea.addEventListener('dir-refresh', load); // Settings fills the textarea (page load, Undo) and tells the table
  // Other parts of the page (naming a voice) add or update a person: detail = { name, title, dept, desig, org, email }
  textarea.addEventListener('dir-upsert', (e) => {
    rows = rows.filter((r) => r.name.trim() || r.title || r.dept || r.desig || r.org || r.email);
    rows = upsertRow(rows, e.detail || {});
    if (!rows.length) rows = [blank()];
    emit();
    draw();
  });
  // A voice was renamed: the person keeps their details under the new name
  textarea.addEventListener('dir-rename', (e) => {
    const { from, to } = e.detail || {};
    const row = findRow(rows, from);
    if (row && to && !findRow(rows, to)) {
      row.name = String(to).trim();
      emit();
      draw();
    }
  });
  // "Details" on a voice: scroll to that person's row and focus the first empty detail
  textarea.addEventListener('dir-focus', (e) => {
    const name = e.detail?.name;
    if (!name) return;
    rows = rows.filter((r) => r.name.trim() || r.title || r.dept || r.desig || r.org || r.email);
    if (!findRow(rows, name)) rows = upsertRow(rows, { name });
    emit();
    draw();
    const i = rows.findIndex((r) => r.name.trim().toLowerCase() === String(name).trim().toLowerCase());
    const first = ['desig', 'org', 'dept', 'title', 'email'].find((k) => !rows[i][k]) || 'desig';
    const input = host.querySelector(`[data-key="${i}.${first}"]`);
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input?.focus();
  });
  load();
}
