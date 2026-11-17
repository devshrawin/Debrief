// The one markdown renderer for everything shown or sent: minutes, answers, emails.
import { fmtDue } from './datefmt.js';
import { marked } from 'marked';

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Anything a speaker or the model slips in is neutralised: no raw HTML, no images (an image address can
// carry data out to anyone's server), and only web or mail links.
marked.use({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text || ''),
    link(token) {
      const inner = this.parser.parseInline(token.tokens);
      const href = String(token.href || '');
      return /^(https?:\/\/|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${inner}</a>` : inner;
    },
  },
});

export const renderMd = (md) => marked.parse(md || '');

// On-screen polish for the minutes page only (never used for email, Word or print output): wraps tables so they
// scroll sideways on a narrow screen, turns Absent/Yes attendance cells into chips, and boxes the
// 'Added by the completeness check' section and the closing 'Written with ...' note.
// A table of actions (it has an Action, Owner or Due column) can stack its rows on a narrow screen: each cell gets its column's
// name as a small label (data-label, set as an attribute from the header's text; no HTML is built). A table whose only row says
// "None recorded." is just that line. Wide tables of another kind (attendance, updates by person) keep scrolling sideways.
function labelCells(t) {
  const heads = [...(t.tHead?.rows[0]?.cells || t.rows[0]?.cells || [])].map((c) => c.textContent.trim());
  const isActions = heads.some((h) => /^(action|owner|due)/i.test(h));
  const body = [...t.querySelectorAll('tbody tr')];
  const only = body.length === 1 ? body[0].textContent.replace(/[—–\s]+/g, ' ').trim() : '';
  if (isActions && /^none recorded\.?$/i.test(only)) {
    const p = document.createElement('p');
    p.className = 'none-rec';
    p.textContent = 'None recorded.';
    (t.parentElement.classList.contains('tablewrap') ? t.parentElement : t).replaceWith(p);
    return;
  }
  if (!isActions) return;
  t.dataset.stack = '1';
  for (const tr of body) {
    [...tr.cells].forEach((td, i) => {
      if (!heads[i]) return;
      td.setAttribute('data-label', heads[i]);
      // a due date that can be read as a date is shown as "16 Nov 2026" like everywhere else on screen; other text stays as written
      if (/^due/i.test(heads[i]) && !td.children.length) td.textContent = fmtDue(td.textContent.trim());
    });
  }
}

export function decorateMinutes(root) {
  for (const t of root.querySelectorAll('table')) {
    if (t.parentElement.classList.contains('tablewrap')) continue;
    const w = document.createElement('div');
    w.className = 'tablewrap';
    t.replaceWith(w);
    w.append(t);
  }
  for (const t of root.querySelectorAll('table')) labelCells(t);
  for (const td of root.querySelectorAll('td')) {
    const v = td.textContent.trim();
    if (/^(absent|yes)$/i.test(v)) {
      const chip = document.createElement('span');
      chip.className = `chip ${/^yes$/i.test(v) ? 'ok' : 'warn'}`;
      chip.textContent = v;
      td.replaceChildren(chip);
    }
  }
  const head = [...root.querySelectorAll('h2')].find((h) => /^added by the completeness check/i.test(h.textContent.trim()));
  if (head) {
    const box = document.createElement('div');
    box.className = 'added';
    head.before(box);
    let n = head;
    while (n && (n === head || !/^(H[12]|HR)$/.test(n.tagName))) {
      const next = n.nextElementSibling;
      box.append(n);
      n = next;
    }
    const first = box.querySelector('p');
    if (first && first.children.length === 1 && first.firstElementChild.tagName === 'EM') first.className = 'note';
  }
  const last = root.lastElementChild;
  if (last?.tagName === 'P' && last.children.length === 1 && last.firstElementChild.tagName === 'EM' && /^written (with|by)/i.test(last.textContent.trim())) last.className = 'foot';
}
