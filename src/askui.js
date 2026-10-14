// The "ask about the minutes" box. Used on a meeting's minutes page (that meeting only) and on the
// all-meetings page. It keeps the conversation on screen, streams the answer and lists its sources.
import { getSettings, llmReady } from './store.js';
import { generate, isRetryable } from './llm.js';
import { askMeetings, SUGGESTIONS } from './ask.js';
import { renderMd } from './md.js';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One stylesheet for both pages that mount the box (minutes page, ask page), tokens from style.css.
const CSS = `
.ask { padding: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.ask-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chipbtn { font-size: 13px; font-weight: 600; min-height: 32px; padding: 3px 12px; border-radius: 999px; }
.ask-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.ask-row input { flex: 1; min-width: 0; }
.ask > .hint { margin-top: 8px; }
.ask > .hint:empty { display: none; }
.ask .hint.busy { display: flex; gap: 10px; align-items: center; color: var(--muted); }
.ask .hint.busy::before { content: ""; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--brand); border-right-color: transparent; animation: sp 0.8s linear infinite; flex: none; }
.ask-log { margin-top: 10px; }
.ask-log:empty { display: none; }
.ask-turn { margin: 12px 0 0; }
.ask-q { font-weight: 600; overflow-wrap: anywhere; }
.ask-a { margin: 6px 0 0; padding: 10px 14px; border-left: 3px solid var(--brand); background: var(--sunk); border-radius: 0 10px 10px 0; font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; }
.ask-a p { margin: 4px 0; }
.ask-a ul, .ask-a ol { margin: 4px 0; padding-left: 22px; }
.ask-a li { margin: 4px 0; }
.ask-a.live > :last-child::after { content: ""; display: inline-block; width: 8px; height: 18px; margin-left: 3px; background: var(--brand); vertical-align: text-bottom; animation: bl 1s steps(2) infinite; }
@keyframes bl { 50% { opacity: 0; } }
.ask-a .src, .ask-srcs .src { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 6px; background: var(--tint); color: var(--tint-ink); font-size: 11.5px; font-weight: 800; text-decoration: none; vertical-align: 2px; margin-left: 2px; }
.ask-a a.src:hover { background: var(--brand); color: var(--on-brand); }
.ask-src { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 13px; }
.ask-srcs { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.ask-srcs li { display: flex; gap: 10px; align-items: baseline; min-height: 32px; flex-wrap: wrap; }
.ask-srcs .src { margin: 0; vertical-align: baseline; }
.ask-srcs a { font-weight: 600; overflow-wrap: anywhere; }
.ask-a.nomatch { border: 1px solid var(--line); border-radius: 14px; background: var(--card); text-align: center; padding: 28px; }
.ask-a.err { border: 1px solid var(--rec-line); border-radius: 14px; background: var(--rec-bg); color: var(--rec-ink); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.ask-a.err > div { flex: 1 1 260px; }
.ask-a.err p { margin: 2px 0 0; }
.ask-notice { margin-top: 10px; padding: 14px 16px; border-radius: 14px; background: var(--amber-bg); border: 1px solid var(--amber-line); color: var(--amber-ink); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.ask-notice > div { flex: 1 1 260px; }
.ask-notice p { margin: 2px 0 0; }
.ask-lbl { margin: 14px 0 6px; }

/* the big version on the all-meetings page */
.ask.large { display: flex; flex-direction: column; gap: 16px; padding: 0; background: none; border: 0; box-shadow: none; }
.ask.large > * { margin: 0; }
.ask.large .ask-row { order: 1; padding: 8px 8px 8px 18px; gap: 10px; background: var(--card); border: 1px solid var(--brand); border-radius: 14px; box-shadow: 0 0 0 3px var(--tint); }
.ask.large .ask-row input { border: 0; background: transparent; font-size: 17px; min-height: 44px; padding: 8px 0; box-shadow: none; }
.ask.large .ask-row input:focus-visible { outline: none; }
.ask.large .ask-row .primary { width: 44px; height: 44px; padding: 0; border-radius: 12px; flex: none; }
.ask.large > .hint { order: 2; font-size: 14px; }
.ask.large .ask-notice { order: 3; }
.ask.large .ask-log { order: 4; }
.ask.large .ask-lbl { order: 5; }
.ask.large .ask-chips { order: 6; }
.ask.large .ask-turn { margin: 0 0 16px; }
.ask.large .ask-q { font-size: 13px; color: var(--muted); }
.ask.large .ask-a { border-left: 0; background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); padding: 20px 26px; font-size: 15.5px; }
.ask.large .ask-a.nomatch { padding: 28px; }
.ask.large .ask-a.err { background: var(--rec-bg); border-color: var(--rec-line); }
.ask-lbl.hidden, .ask.large .ask-chips.hidden { display: none; }
`;
function injectStyle() {
  if (document.getElementById('askui-style')) return;
  const s = h('style', null, CSS);
  s.id = 'askui-style';
  document.head.append(s);
}

// Replaces "[Meeting, 12 Oct 2026, 14:20]" in a rendered answer by a numbered chip that jumps to the source list.
function linkCitations(root, sources, prefix) {
  const index = new Map();
  for (const s of sources || []) if (!index.has(s.label)) index.set(s.label, index.size + 1);
  if (!index.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!node.nodeValue.includes('[')) continue;
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(/\[([^\[\]]+)\]/g)) {
      const n = index.get(m[1].trim());
      if (!n) continue;
      frag.append(text.slice(last, m.index));
      const a = h('a', 'src', String(n));
      a.href = `#${prefix}${n}`;
      a.setAttribute('aria-label', `Source ${n}`);
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (!last) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

let turnNo = 0;

// opts: { getMeetings(): Promise<meeting[]>, getCtx(): ctx, history: [{q,a}], onEntry(entry), suggestions?: string[], openLink?: boolean, large?: boolean }
export function mountAsk(root, opts) {
  injectStyle();
  const history = [...(opts.history || [])];
  root.classList.add('ask');
  if (opts.large) root.classList.add('large');
  const log = h('div', 'ask-log');
  log.setAttribute('aria-live', 'polite');
  const label = h('p', 'lbl ask-lbl', 'Try asking');
  const chips = h('div', 'ask-chips');
  const row = h('div', 'ask-row');
  const input = h('input');
  input.type = 'text';
  input.placeholder = opts.placeholder || 'Ask anything about the meeting, e.g. "who owns the Kerala mapping?"';
  input.setAttribute('aria-label', 'Your question');
  const go = h('button', 'primary');
  if (opts.large) {
    go.setAttribute('aria-label', 'Ask');
    go.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>';
  } else go.textContent = 'Ask';
  const stop = h('button', 'hidden', 'Stop');
  const status = h('span', 'hint');
  status.setAttribute('role', 'status');
  const notice = h('div', 'ask-notice hidden');
  notice.setAttribute('role', 'alert');
  row.append(input, go, stop);
  if (opts.large) root.append(row, status, notice, log, label, chips);
  else root.append(chips, row, status, notice, log);
  if (!opts.large) label.remove();
  let abort = null;

  const setBusy = (text) => {
    status.textContent = text;
    status.classList.toggle('busy', !!text);
  };
  const showNotice = (on) => {
    notice.classList.toggle('hidden', !on);
    if (!on) return;
    notice.replaceChildren();
    const d = h('div');
    d.append(h('strong', null, 'Choose a model for answers first'), h('p', null, 'Asking uses the same service as your minutes. None is set up yet.'));
    const b = h('button', null, 'Open Settings');
    b.onclick = () => (chrome.runtime?.openOptionsPage ? chrome.runtime.openOptionsPage() : window.open('options.html'));
    notice.append(d, b);
  };

  const addTurn = (q, a, sources) => {
    const turn = h('div', 'ask-turn');
    const qEl = h('div', 'ask-q', q);
    const aEl = h('div', 'ask-a');
    turn.append(qEl, aEl);
    log.prepend(turn);
    if (a != null) fill(aEl, a, sources);
    return { turn, aEl };
  };
  const fill = (aEl, answer, sources) => {
    aEl.classList.remove('live', 'err');
    aEl.innerHTML = renderMd(answer);
    const uniq = [];
    const seen = new Set();
    for (const s of sources || []) {
      if (seen.has(s.label)) continue;
      seen.add(s.label);
      uniq.push(s);
    }
    if (!uniq.length) {
      aEl.classList.toggle('nomatch', !(sources && sources.length) && /^(Nothing in these|There are no)/.test(answer));
      return;
    }
    const prefix = `ask-s${++turnNo}-`;
    linkCitations(aEl, uniq, prefix);
    const src = h('div', 'ask-src');
    src.append(h('p', 'lbl', 'Sources'));
    const list = h('ol', 'ask-srcs');
    uniq.forEach((s, i) => {
      const li = h('li');
      li.id = `${prefix}${i + 1}`;
      li.append(h('span', 'src', String(i + 1)));
      if (opts.openLink && s.meetingId) {
        const a = h('a', null, s.label);
        a.href = `mom.html?id=${encodeURIComponent(s.meetingId)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        li.append(a);
      } else li.append(h('span', 'hint', s.label));
      list.append(li);
    });
    src.append(list);
    aEl.append(src);
  };

  history.slice(-6).reverse().forEach((e) => addTurn(e.q, e.a, e.sources));
  for (const s of opts.suggestions || SUGGESTIONS) {
    const b = h('button', 'chipbtn', s);
    b.onclick = () => {
      input.value = s;
      ask();
    };
    chips.append(b);
  }

  async function ask(again) {
    const question = (again || input.value).trim();
    if (!question || abort) return;
    const settings = await getSettings();
    if (!llmReady(settings)) {
      status.textContent = 'Set up a minutes writer (LLM) in Settings first.';
      status.classList.remove('busy');
      showNotice(true);
      return;
    }
    showNotice(false);
    if (opts.large) label.classList.add('hidden'), chips.classList.add('hidden');
    input.value = '';
    setBusy('Searching the meeting…');
    abort = new AbortController();
    go.disabled = true;
    stop.classList.remove('hidden');
    stop.onclick = () => abort?.abort();
    const { turn, aEl } = addTurn(question, null);
    aEl.classList.add('live');
    aEl.textContent = '…';
    let buf = '';
    let queued = false;
    const paint = () => {
      queued = false;
      if (abort) aEl.innerHTML = renderMd(buf);
    };
    const gen = async (system, user, onText) => {
      for (let i = 0; ; i++) {
        try {
          return await generate({ settings, system, user, signal: abort.signal, onText: onText || (() => {}) });
        } catch (e) {
          if (i >= 2 || !isRetryable(e)) throw e;
          setBusy(`Busy (${e.message.slice(0, 60)}). Trying again…`);
          await sleep([4000, 12000][i]);
        }
      }
    };
    try {
      const meetings = await opts.getMeetings();
      const r = await askMeetings({
        question,
        meetings,
        ctx: opts.getCtx(),
        history,
        gen,
        onText: (d) => {
          buf += d;
          setBusy('Answering…');
          if (!queued) {
            queued = true;
            requestAnimationFrame(paint);
          }
        },
      });
      fill(aEl, r.answer, r.sources);
      const entry = { q: question, a: r.answer, sources: r.sources.slice(0, 8), at: Date.now() };
      history.push(entry);
      opts.onEntry?.(entry);
      setBusy('');
    } catch (e) {
      aEl.classList.remove('live');
      if (abort.signal.aborted) aEl.textContent = 'Stopped.';
      else {
        aEl.classList.add('err');
        const d = h('div');
        d.append(h('strong', null, 'No answer this time'), h('p', null, `Could not answer: ${e.message}`), h('p', 'hint', 'Your question is kept.'));
        const retry = h('button', null, 'Try again');
        retry.onclick = () => {
          turn.remove();
          ask(question);
        };
        aEl.replaceChildren(d, retry);
      }
      setBusy('');
    } finally {
      abort = null;
      go.disabled = false;
      stop.classList.add('hidden');
      input.focus();
    }
  }
  go.onclick = () => ask();
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) ask();
  };
  return { ask, history };
}
