// "Who else gets a copy" as a small table: one person per row, with an optional "only for meetings titled …" column.
// The settings stay as text (shareList: default people; shareGroups: "Words from the title | a@x.com, b@y.com" per line),
// because the sender and the script allow-list read them in that form. This table reads and writes those two text fields,
// kept in hidden textareas, so saving, Undo and "copy the script with these people allowed" work unchanged.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const emailsIn = (text) => [...new Set((String(text || '').match(EMAIL) || []).map((x) => x.toLowerCase()))];
const looksValid = (x) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(x).trim());

export function rowsFrom(listText, groupsText) {
  const rows = emailsIn(listText).map((email) => ({ email, group: '' }));
  for (const raw of String(groupsText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('|')) continue;
    const i = line.indexOf('|');
    const group = line.slice(0, i).trim();
    for (const email of emailsIn(line.slice(i + 1))) rows.push({ email, group });
  }
  return rows;
}

export function textsFrom(rows) {
  const ok = rows.filter((r) => looksValid(r.email));
  const list = [...new Set(ok.filter((r) => !r.group.trim()).map((r) => r.email.trim().toLowerCase()))].join(', ');
  const groups = new Map();
  for (const r of ok.filter((x) => x.group.trim())) {
    const g = r.group.trim().replace(/\|/g, ' ');
    if (!groups.has(g)) groups.set(g, new Set());
    groups.get(g).add(r.email.trim().toLowerCase());
  }
  return { list, groups: [...groups].map(([g, set]) => `${g} | ${[...set].join(', ')}`).join('\n') };
}

// listTa, groupsTa: the hidden textareas. groupsTa may be null (the tour only edits the default people).
export function mountRecipients(host, listTa, groupsTa) {
  if (!host || !listTa) return;
  let rows = [];
  const blank = () => ({ email: '', group: '' });
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
  const emit = () => {
    const t = textsFrom(rows);
    listTa.value = t.list;
    listTa.dispatchEvent(new Event('input', { bubbles: true }));
    if (groupsTa) {
      groupsTa.value = t.groups;
      groupsTa.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  function draw(focus) {
    host.replaceChildren();
    const head = make('div', { class: `rec-row rec-head${groupsTa ? '' : ' one'}`, role: 'row' }, make('span', { role: 'columnheader' }, 'Email'), groupsTa ? make('span', { role: 'columnheader' }, 'Only for meetings titled…') : null, make('span'));
    const body = make('div', { class: 'rec-body', role: 'rowgroup' });
    rows.forEach((r, ri) => {
      const email = make('input', { class: 'rec-in', type: 'text', inputmode: 'email', value: r.email, placeholder: ri === 0 ? 'priya@company.com' : '', 'aria-label': `Email, person ${ri + 1}`, autocomplete: 'off', spellcheck: 'false' });
      const mark = () => email.setAttribute('aria-invalid', String(!!email.value.trim() && !looksValid(email.value)));
      mark();
      email.addEventListener('input', () => {
        r.email = email.value;
        mark();
        emit();
      });
      email.addEventListener('paste', (e) => {
        const found = emailsIn(e.clipboardData?.getData('text') || '');
        if (found.length < 2) return; // one address pastes as usual
        e.preventDefault();
        rows.splice(ri, 1, ...found.map((x) => ({ email: x, group: r.group })));
        emit();
        draw();
      });
      email.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        rows.splice(ri + 1, 0, { email: '', group: r.group });
        emit();
        draw(`${ri + 1}.email`);
      });
      email.dataset.key = `${ri}.email`;
      const group = groupsTa ? make('input', { class: 'rec-in', type: 'text', value: r.group, placeholder: 'all meetings', 'aria-label': `Only for meetings titled, person ${ri + 1}`, autocomplete: 'off' }) : null;
      group?.addEventListener('input', () => {
        r.group = group.value;
        emit();
      });
      const del = make('button', { class: 'rec-x', type: 'button', title: 'Remove', 'aria-label': `Remove ${r.email || `person ${ri + 1}`}` }, '×');
      del.addEventListener('click', () => {
        rows.splice(ri, 1);
        emit();
        draw();
      });
      body.append(make('div', { class: `rec-row${groupsTa ? '' : ' one'}`, role: 'row' }, email, group, del));
    });
    const add = make('button', { class: 'btn sm', type: 'button' }, '+ Add a person');
    add.addEventListener('click', () => {
      rows.push(blank());
      draw(`${rows.length - 1}.email`);
    });
    host.append(make('div', { class: 'rec-table', role: 'table', 'aria-label': 'Who else gets a copy' }, head, body), make('div', { class: 'rec-foot' }, add, make('span', { class: 'hint' }, groupsTa ? 'Leave the second box empty for people who get every meeting. Words from a meeting title (like Cadence Call) give that meeting its own list.' : 'Paste several addresses at once if you like.')));
    if (focus) host.querySelector(`[data-key="${focus}"]`)?.focus();
  }
  const load = () => {
    rows = rowsFrom(listTa.value, groupsTa?.value);
    if (!rows.length) rows = [blank()];
    draw();
  };
  listTa.hidden = true;
  if (groupsTa) groupsTa.hidden = true;
  listTa.addEventListener('rec-refresh', load);
  load();
}
