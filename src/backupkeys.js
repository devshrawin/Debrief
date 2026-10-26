// Any number of extra Gemini backup keys, with a "+" to add one. The first backup key keeps its own field (geminiKey2); the
// rest live in a list (geminiBackups). Keys are secrets: a saved key is shown only as dots and can be removed, never read back.
// Keys that are tried in this order when the main key hits its limit: geminiKey, geminiKey2, then geminiBackups in order.
export function mountBackupKeys(host, addButton) {
  if (!host || !addButton) return { value: () => [], set() {} };
  let saved = []; // keys already stored (their text is known only to the settings code, not shown)
  let removed = new Set();
  let fresh = []; // inputs for keys being added now
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
  const changed = () => host.dispatchEvent(new Event('input', { bubbles: true })); // Settings notices unsaved changes
  function draw() {
    host.replaceChildren();
    let n = 2; // "Backup key" above is the first; this list continues from 2
    saved.forEach((_, i) => {
      if (removed.has(i)) return;
      const label = `Backup key ${n}`;
      n++;
      const rm = make('button', { class: 'btn sm', type: 'button', 'aria-label': `Remove ${label}` }, 'Remove');
      rm.addEventListener('click', () => {
        removed.add(i);
        draw();
        changed();
      });
      host.append(make('div', { class: 'bk-row' }, make('span', { class: 'bk-name' }, label), make('span', { class: 'secret-mask bk-mask', 'aria-label': 'A key is saved' }, '••••••••••••'), make('span', { class: 'chip ok' }, 'Saved'), rm));
    });
    fresh.forEach((f, i) => {
      const label = `Backup key ${n}`;
      n++;
      const input = make('input', { class: 'bk-in', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: 'A key from another Google project', 'aria-label': label });
      input.value = f.v;
      input.addEventListener('input', () => {
        f.v = input.value;
      });
      const rm = make('button', { class: 'btn sm', type: 'button', 'aria-label': `Discard ${label}` }, 'Discard');
      rm.addEventListener('click', () => {
        fresh.splice(i, 1);
        draw();
        changed();
      });
      host.append(make('div', { class: 'bk-row' }, make('label', { class: 'bk-name' }, label), input, rm));
      if (f.focus) {
        f.focus = false;
        queueMicrotask(() => input.focus());
      }
    });
  }
  addButton.addEventListener('click', () => {
    fresh.push({ v: '', focus: true });
    draw();
  });
  return {
    // the keys as they should be stored: the saved ones that were not removed, then the new ones typed in
    value() {
      return [...saved.filter((_, i) => !removed.has(i)), ...fresh.map((f) => f.v.trim()).filter(Boolean)];
    },
    // after loading or saving: these keys are the saved ones now
    set(list) {
      saved = Array.isArray(list) ? list.filter(Boolean) : [];
      removed = new Set();
      fresh = [];
      draw();
    },
  };
}
