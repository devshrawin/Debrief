// A structured editor for the minutes. The minutes are stored as Markdown, but nobody should have to type pipes and dashes:
// this turns the Markdown into blocks (headings, paragraphs, lists, tables), edits those with ordinary fields, and writes the
// same Markdown back. Anything it does not understand is kept as it is, so nothing is lost on the way through.

// ---------------------------------------------------------------- Markdown <-> blocks (pure, no DOM)

const HEAD = /^(#{1,6})\s+(.*)$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const COMMENT = /^\s*<!--.*-->\s*$/;
const isPipeRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => isPipeRow(l) && /-/.test(l) && /^[\s|:-]+$/.test(l);

// "a | b \| c" -> ["a", "b | c"]; a cell keeps <br> as a real line break while it is edited
export function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((x) => x.trim().replace(/<br\s*\/?>/gi, '\n'));
}
const joinCell = (x) => String(x).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
const joinRow = (cells) => `| ${cells.map(joinCell).join(' | ')} |`;

export function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
    } else if (COMMENT.test(l)) {
      blocks.push({ t: 'raw', text: l.trim() });
      i++;
    } else if (HEAD.test(l)) {
      const m = l.match(HEAD);
      blocks.push({ t: 'h', level: m[1].length, text: m[2].trim() });
      i++;
    } else if (isPipeRow(l)) {
      const rows = [];
      while (i < lines.length && isPipeRow(lines[i])) rows.push(lines[i++]);
      const head = splitRow(rows[0]);
      const hasSep = rows[1] && isSep(rows[1]);
      blocks.push({ t: 'table', head, sep: hasSep ? rows[1].trim() : '', rows: rows.slice(hasSep ? 2 : 1).map(splitRow) });
    } else if (ITEM.test(l)) {
      const items = [];
      const ordered = /\d/.test(l.match(ITEM)[2]);
      while (i < lines.length && ITEM.test(lines[i])) {
        const m = lines[i++].match(ITEM);
        items.push({ indent: m[1].replace(/\t/g, '  ').length >= 2 ? 1 : 0, text: m[3].trim() });
      }
      blocks.push({ t: 'list', ordered, items });
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !COMMENT.test(lines[i]) && !HEAD.test(lines[i]) && !isPipeRow(lines[i]) && !ITEM.test(lines[i])) para.push(lines[i++].trim());
      blocks.push({ t: 'p', text: para.join('\n') });
    }
  }
  return blocks;
}

export function serializeBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.t === 'raw') out.push(b.text);
    else if (b.t === 'h') out.push(`${'#'.repeat(b.level)} ${b.text}`.trimEnd());
    else if (b.t === 'p') out.push(b.text.split('\n').map((x) => x.trimEnd()).join('\n'));
    else if (b.t === 'list') {
      let n = 0;
      out.push(
        b.items
          .map((it) => `${it.indent ? '  ' : ''}${b.ordered ? `${it.indent ? 1 : ++n}.` : '-'} ${it.text}`.trimEnd())
          .join('\n')
      );
    } else if (b.t === 'table') {
      const cols = b.head.length;
      const sep = b.sep && splitRow(b.sep).length === cols ? b.sep : `|${Array(cols).fill('---').join('|')}|`;
      out.push([joinRow(b.head), sep, ...b.rows.map((r) => joinRow(Array.from({ length: cols }, (_, k) => r[k] ?? '')))].join('\n'));
    }
  }
  // the format marker (an HTML comment) sits directly above the title, as the writer produces it
  return out.reduce((acc, part, i) => (i === 0 ? part : `${acc}${out[i - 1].startsWith('<!--') ? '\n' : '\n\n'}${part}`), '') + '\n';
}

// The first column of a table that counts rows (SR, SR No., #) is renumbered whenever rows are added or removed.
export const isCounter = (head) => /^(sr\.?( no\.?)?|#|no\.?|sl\.?( no\.?)?)$/i.test((head[0] || '').trim());
export function renumber(block) {
  if (block.t === 'table' && isCounter(block.head)) block.rows.forEach((r, i) => (r[0] = String(i + 1)));
}

// ---------------------------------------------------------------- the editor (DOM)

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}
const grow = (ta) => {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
};
const field = (value, label, onInput, { multiline = true, cls = '' } = {}) => {
  const el = multiline ? h('textarea', { rows: 1, 'aria-label': label, class: `ed-f ${cls}` }) : h('input', { type: 'text', 'aria-label': label, class: `ed-f ${cls}` });
  el.value = value;
  el.addEventListener('input', () => {
    if (multiline) grow(el);
    onInput(el.value);
  });
  if (multiline) requestAnimationFrame(() => grow(el));
  return el;
};

// root: the element to fill. onChange(md) is called after every edit (the caller saves it and refreshes the preview).
export function mountEditor(root, md, onChange) {
  let blocks = parseBlocks(md);
  const history = [];
  let focusNext = null;
  const emit = () => onChange(serializeBlocks(blocks));
  const snapshot = () => {
    history.push(JSON.stringify(blocks));
    if (history.length > 60) history.shift();
  };
  let typing = null;
  const typed = () => {
    // one undo step per burst of typing
    if (!typing) snapshot();
    clearTimeout(typing);
    typing = setTimeout(() => (typing = null), 900);
    emit();
  };
  const change = (fn, focus) => {
    snapshot();
    fn();
    focusNext = focus || null;
    draw();
    emit();
  };

  function drawList(b, bi) {
    const ul = h('div', { class: 'ed-list', role: 'list' });
    b.items.forEach((it, ii) => {
      const f = field(it.text, `Point ${ii + 1}`, (v) => {
        it.text = v;
        typed();
      });
      f.dataset.key = `${bi}.${ii}`;
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          change(() => b.items.splice(ii + 1, 0, { indent: it.indent, text: '' }), `${bi}.${ii + 1}`);
        } else if (e.key === 'Backspace' && !f.value && b.items.length > 1) {
          e.preventDefault();
          change(() => b.items.splice(ii, 1), `${bi}.${Math.max(0, ii - 1)}`);
        }
      });
      ul.append(
        h('div', { class: `ed-item${it.indent ? ' sub' : ''}`, role: 'listitem' },
          h('span', { class: 'ed-bullet', 'aria-hidden': 'true' }, b.ordered ? `${ii + 1}.` : '•'),
          f,
          h('button', { type: 'button', class: 'ed-x', title: 'Remove this point', 'aria-label': `Remove point ${ii + 1}`, onclick: () => change(() => b.items.splice(ii, 1)) }, '×'))
      );
    });
    return h('div', { class: 'ed-block' }, ul,
      h('button', { type: 'button', class: 'ed-add', onclick: () => change(() => b.items.push({ indent: 0, text: '' }), `${bi}.${b.items.length}`) }, '+ Add a point'));
  }

  function drawTable(b, bi) {
    const counter = isCounter(b.head);
    const head = h('tr', {}, ...b.head.map((t, ci) => h('th', {}, field(t, `Column ${ci + 1} title`, (v) => {
      b.head[ci] = v;
      typed();
    }, { multiline: false, cls: 'ed-th' }))), h('th', { class: 'ed-gutter' }));
    const body = b.rows.map((r, ri) =>
      h('tr', {}, ...b.head.map((_, ci) => {
        if (counter && ci === 0) return h('td', { class: 'ed-no' }, String(ri + 1));
        const f = field(r[ci] ?? '', `${b.head[ci] || `Column ${ci + 1}`}, row ${ri + 1}`, (v) => {
          r[ci] = v;
          typed();
        });
        f.dataset.key = `${bi}.${ri}.${ci}`;
        return h('td', {}, f);
      }), h('td', { class: 'ed-gutter' },
        h('button', { type: 'button', class: 'ed-x', title: 'Remove this row', 'aria-label': `Remove row ${ri + 1}`, onclick: () => change(() => { b.rows.splice(ri, 1); renumber(b); }) }, '×')))
    );
    return h('div', { class: 'ed-block' },
      h('div', { class: 'ed-scroll' }, h('table', { class: 'ed-table' }, h('thead', {}, head), h('tbody', {}, ...body))),
      h('button', { type: 'button', class: 'ed-add', onclick: () => change(() => { b.rows.push(Array(b.head.length).fill('')); renumber(b); }, `${bi}.${b.rows.length}.${counter ? 1 : 0}`) }, '+ Add a row'));
  }

  function draw() {
    root.replaceChildren();
    blocks.forEach((b, bi) => {
      if (b.t === 'raw') return; // the format marker and similar comments are kept, not shown
      let el;
      if (b.t === 'h') {
        const f = field(b.text, 'Heading', (v) => {
          b.text = v;
          typed();
        }, { multiline: false, cls: `ed-h ed-h${Math.min(b.level, 3)}` });
        el = h('div', { class: 'ed-block ed-head' }, f);
      } else if (b.t === 'p') {
        el = h('div', { class: 'ed-block' }, field(b.text, 'Text', (v) => {
          b.text = v;
          typed();
        }, { cls: 'ed-p' }));
      } else if (b.t === 'list') el = drawList(b, bi);
      else el = drawTable(b, bi);
      // a list, table or paragraph can be taken out as a whole
      if (b.t !== 'h') el.append(h('button', { type: 'button', class: 'ed-rm', onclick: () => change(() => blocks.splice(bi, 1)) }, b.t === 'table' ? 'Remove this table' : b.t === 'list' ? 'Remove this list' : 'Remove this text'));
      root.append(el);
    });
    root.append(h('div', { class: 'ed-foot' }, h('button', { type: 'button', class: 'ed-add', onclick: () => change(() => blocks.push({ t: 'h', level: 2, text: 'New section' }, { t: 'list', ordered: false, items: [{ indent: 0, text: '' }] }), 'last') }, '+ Add a section')));
    if (focusNext) {
      const key = focusNext === 'last' ? [...root.querySelectorAll('.ed-f')].at(-1) : root.querySelector(`[data-key="${focusNext}"]`);
      key?.focus();
      focusNext = null;
    }
  }

  draw();
  return {
    undo() {
      const prev = history.pop();
      if (!prev) return false;
      blocks = JSON.parse(prev);
      draw();
      emit();
      return true;
    },
    canUndo: () => history.length > 0,
    // used when the text version was edited by hand
    load(newMd) {
      blocks = parseBlocks(newMd);
      draw();
    },
    getMd: () => serializeBlocks(blocks),
  };
}
