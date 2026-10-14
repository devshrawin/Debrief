// A small in-page dialog. The browser's own confirm() and prompt() are silently skipped (they return "no") once
// Chrome has offered to "prevent this page from creating additional dialogs", which made buttons look dead.
// modal({ text, input, select, buttons }) resolves with { value, input, select }, or null if dismissed.
export function modal({ title = '', text = '', input = null, select = null, buttons = [{ label: 'OK', value: 'ok', primary: true }] } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dbmodal';
    const h = document.createElement('div');
    h.style.cssText = 'white-space:pre-wrap;line-height:1.6;font-size:14.5px;color:var(--text)';
    h.textContent = [title, text].filter(Boolean).join('\n\n');
    dlg.append(h);
    let inp = null;
    let sel = null;
    if (input) {
      inp = Object.assign(document.createElement('input'), { value: input.value || '', placeholder: input.placeholder || '', maxLength: input.maxLength || 80 });
      inp.style.marginTop = '12px';
      dlg.append(inp);
    }
    if (select) {
      sel = document.createElement('select');
      sel.style.marginTop = '12px';
      for (const o of select) sel.append(Object.assign(document.createElement('option'), { value: o.value, textContent: o.label }));
      dlg.append(sel);
    }
    const row = document.createElement('div');
    row.className = 'dbbtns';
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px';
    const done = (value) => {
      const out = value == null ? null : { value, input: inp?.value ?? '', select: sel?.value ?? '' };
      dlg.close();
      dlg.remove();
      resolve(out);
    };
    for (const b of buttons) {
      const el = Object.assign(document.createElement('button'), { className: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, textContent: b.label });
      el.dataset.value = b.value;
      el.onclick = () => done(b.value);
      row.append(el);
    }
    dlg.append(row);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    if (inp) inp.addEventListener('keydown', (e) => e.key === 'Enter' && done(buttons.find((b) => b.primary)?.value ?? buttons.at(-1).value));
    document.body.append(dlg);
    dlg.showModal();
    (inp || row.querySelector('.primary') || row.lastChild)?.focus();
  });
}
