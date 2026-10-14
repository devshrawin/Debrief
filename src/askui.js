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

// opts: { getMeetings(): Promise<meeting[]>, getCtx(): ctx, history: [{q,a}], onEntry(entry), suggestions?: string[], openLink?: boolean }
export function mountAsk(root, opts) {
  const history = [...(opts.history || [])];
  root.classList.add('ask');
  const log = h('div', 'ask-log');
  const chips = h('div', 'ask-chips');
  const row = h('div', 'ask-row');
  const input = h('input');
  input.type = 'text';
  input.placeholder = opts.placeholder || 'Ask anything about the meeting, e.g. "who owns the Kerala mapping?"';
  input.setAttribute('aria-label', 'Your question');
  const go = h('button', 'primary', 'Ask');
  const stop = h('button', 'hidden', 'Stop');
  const status = h('span', 'hint');
  row.append(input, go, stop);
  root.append(chips, row, status, log);
  let abort = null;

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
    aEl.innerHTML = renderMd(answer);
    if (sources?.length) {
      const seen = new Set();
      const src = h('div', 'ask-src');
      src.append(h('span', 'hint', 'Sources: '));
      for (const s of sources) {
        if (seen.has(s.label)) continue;
        seen.add(s.label);
        if (opts.openLink && s.meetingId) {
          const a = h('a', null, s.label);
          a.href = `mom.html?id=${s.meetingId}`;
          a.target = '_blank';
          src.append(a, ' · ');
        } else src.append(h('span', 'hint', `${s.label} · `));
      }
      aEl.append(src);
    }
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

  async function ask() {
    const question = input.value.trim();
    if (!question || abort) return;
    const settings = await getSettings();
    if (!llmReady(settings)) {
      status.textContent = 'Set up a minutes writer (LLM) in Settings first.';
      return;
    }
    input.value = '';
    status.textContent = 'Searching the meeting…';
    abort = new AbortController();
    go.disabled = true;
    stop.classList.remove('hidden');
    stop.onclick = () => abort?.abort();
    const { aEl } = addTurn(question, null);
    aEl.textContent = '…';
    let buf = '';
    let queued = false;
    const paint = () => {
      queued = false;
      aEl.textContent = buf;
    };
    const gen = async (system, user, onText) => {
      for (let i = 0; ; i++) {
        try {
          return await generate({ settings, system, user, signal: abort.signal, onText: onText || (() => {}) });
        } catch (e) {
          if (i >= 2 || !isRetryable(e)) throw e;
          status.textContent = `Busy (${e.message.slice(0, 60)}). Trying again…`;
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
          status.textContent = 'Answering…';
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
      status.textContent = '';
    } catch (e) {
      aEl.textContent = abort.signal.aborted ? 'Stopped.' : `Could not answer: ${e.message}`;
      status.textContent = '';
    } finally {
      abort = null;
      go.disabled = false;
      stop.classList.add('hidden');
      input.focus();
    }
  }
  go.onclick = ask;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') ask();
  };
  return { ask, history };
}
