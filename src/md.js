// The one markdown renderer for everything shown or sent: minutes, answers, emails.
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
