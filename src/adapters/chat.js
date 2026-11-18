// Posts one plain-text line in the Google Meet chat (used for the "this meeting is being recorded" notice).
// Meet's markup is not a public API, so like meet.js this relies on ARIA labels, roles and text, never class
// names, and every function returns a clear result instead of throwing. Checked on fake markup only.

const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const labelOf = (el) => (el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').trim();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const CHAT_BUTTON = /chat with everyone|open chat|^chat$|in-call messages|(close|hide) chat/i;
const INPUT_LABEL = /send a message|message to everyone|send message/i;
const SEND_LABEL = /send (a )?message|^send$/i;
const NOT_CHAT_REGION = /question|q&a|poll|add (other )?people|people|caption|search/i;
const TURNED_OFF = /chat is (turned|switched) off|chat (has been )?(turned|switched) off|can'?t send messages|cannot send messages|only hosts? can (send|chat)|chat (is )?disabled|host has (turned off|disabled) chat/i;

const isDisabled = (el) => !!el && (el.disabled === true || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');

function inCallNow(doc) {
  return [...doc.querySelectorAll('button[aria-label], [role="button"][aria-label]')].some((b) => /leave call/i.test(labelOf(b)));
}

// A box inside some other dialog or panel (Add people, Q&A, polls) is never the chat box.
function wrongPlace(el) {
  const host = el.closest('[role="dialog"], [role="region"], [role="complementary"], aside');
  if (!host) return false;
  const l = labelOf(host);
  if (!l || /chat|message/i.test(l)) return false;
  return NOT_CHAT_REGION.test(l) || host.matches('[role="dialog"]');
}

// ---- finding things -----------------------------------------------------------------------------
export function chatButton(doc) {
  const buttons = [...doc.querySelectorAll('button, [role="button"]')];
  let el = buttons.find((b) => CHAT_BUTTON.test(labelOf(b)) && !b.closest('[role="dialog"]'));
  if (!el) {
    // a button that controls a panel labelled as chat
    el = buttons.find((b) => {
      const id = b.getAttribute('aria-controls');
      const target = id && doc.getElementById(id);
      return target && /chat/i.test(labelOf(target));
    });
  }
  if (!el) return null;
  const state = el.getAttribute('aria-pressed') ?? el.getAttribute('aria-expanded');
  const open = state != null ? state === 'true' : /close|hide/i.test(labelOf(el));
  return { el, open: open || /^(close|hide) chat/i.test(labelOf(el)) };
}

export function chatInput(doc) {
  const cands = [...doc.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter((e) => !wrongPlace(e));
  const byLabel = cands.find((e) => INPUT_LABEL.test(labelOf(e)));
  if (byLabel) return byLabel;
  const panels = [...doc.querySelectorAll('[role="region"], [role="complementary"], aside')].filter((p) => /chat|messages/i.test(labelOf(p)));
  for (const p of panels) {
    const boxes = [...p.querySelectorAll('textarea')].filter((e) => !wrongPlace(e));
    if (boxes.length === 1) return boxes[0];
  }
  return null;
}

function chatPanel(doc, input) {
  const near = input?.closest('[role="region"], [role="complementary"], aside, [role="dialog"]');
  if (near) return near;
  return [...doc.querySelectorAll('[role="region"], [role="complementary"], aside, [role="dialog"]')].find((p) => /chat|messages/i.test(labelOf(p))) || null;
}

export function sendButton(doc, input) {
  const ok = (b) => SEND_LABEL.test(labelOf(b)) && !isDisabled(b);
  for (let up = input?.parentElement, i = 0; up && i < 5; up = up.parentElement, i++) {
    const b = [...up.querySelectorAll('button, [role="button"]')].find(ok);
    if (b) return b;
  }
  return null;
}

export function chatAllowed(doc) {
  const input = chatInput(doc);
  if (input && (input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true' || input.getAttribute('aria-readonly') === 'true')) return false;
  const scope = chatPanel(doc, input) || doc.body;
  return ![...scope.querySelectorAll('*')].some((n) => !n.children.length && n.textContent.length < 160 && TURNED_OFF.test(n.textContent));
}

// Is this chat message one the user sent? Meet groups messages under a header with the sender's name ("You" for your
// own) and the time; some builds also mark the message itself. When it cannot be told, the answer is no: a second
// notice is harmless, a notice held back because someone else pasted the same words is not.
const SELF_ATTRS = ['data-is-self', 'data-self', 'data-is-own', 'data-from-me', 'data-sender-is-self', 'data-is-me'];
// aria text that Meet itself writes for the local user's own message. A visible sender label ("You") is NOT evidence:
// any participant can set that as their display name.
const SELF_LABEL = /^(sent by you|message from you|your message)\b/i;
const CLOCK = /^\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?$/i;
const leaves = (el) => [...el.querySelectorAll('*')].filter((n) => !n.children.length && norm(n.textContent));
function fromMe(node, panel) {
  for (let up = node.parentElement, i = 0; up && up !== panel && i < 6; up = up.parentElement, i++) {
    if (SELF_ATTRS.some((a) => up.getAttribute(a) === 'true')) return true;
    if (SELF_ATTRS.some((a) => up.getAttribute(a) === 'false')) return false;
    if (SELF_LABEL.test(up.getAttribute('aria-label') || '')) return true;
    // the message group: the nearest box whose first lines are a sender and a time. Its visible sender text proves
    // nothing about who sent it (a participant can be named "You"), so the answer there is no.
    const ls = leaves(up);
    const head = ls.slice(0, 2).map((n) => norm(n.textContent));
    if (ls[0] !== node && head.length === 2 && CLOCK.test(head[1])) return false;
  }
  return false;
}

// The notice is already in the chat, sent by the user (a reload, a second attempt). Only the chat panel counts, never
// the rest of the page, and only the user's own message.
export function alreadyPosted(doc, msg) {
  const want = norm(msg);
  if (!want) return false;
  const panel = chatPanel(doc, chatInput(doc));
  if (!panel) return false;
  return [...panel.querySelectorAll('*')].some((n) => !n.children.length && !n.closest('textarea, [contenteditable="true"], [role="textbox"], button, [role="button"]') && norm(n.textContent) === want && !!fromMe(n, panel));
}

// ---- posting ------------------------------------------------------------------------------------
const valueOf = (el) => norm('value' in el && el.tagName === 'TEXTAREA' ? el.value : el.textContent);

function putText(el, msg, win) {
  el.focus?.();
  if (el.tagName === 'TEXTAREA') {
    // the native setter, so inputs controlled by a framework notice the change
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(el, msg);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  } else {
    el.textContent = msg;
    const init = { bubbles: true, inputType: 'insertText', data: msg };
    el.dispatchEvent(new win.InputEvent('beforeinput', init));
    el.dispatchEvent(new win.InputEvent('input', init));
  }
}

function clearText(el, win) {
  if (el.tagName === 'TEXTAREA') {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  } else {
    el.textContent = '';
    el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  }
}

export function cleanNotice(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300).trim();
}

export async function postNotice(doc, msg, { win = doc.defaultView, wait = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 4000 } = {}) {
  const clean = cleanNotice(msg);
  if (!clean) return { ok: false, why: 'nothing to post' };
  if (!inCallNow(doc)) return { ok: false, why: 'not in a call' };

  // poll without real clocks, so a test can pass a instant wait()
  const until = async (fn, ms, step) => {
    for (let t = 0; ; t += step) {
      const v = fn();
      if (v) return v;
      if (t >= ms) return null;
      await wait(step);
    }
  };

  let weOpened = null;
  const btn = chatButton(doc);
  let input = chatInput(doc);
  if (!input) {
    if (!btn) return { ok: false, why: 'could not find the chat button' };
    if (!btn.open) {
      btn.el.click();
      weOpened = btn.el;
    }
    input = await until(() => chatInput(doc) || (!chatAllowed(doc) ? 'off' : null), timeoutMs, 100);
  }
  const restore = () => {
    if (!weOpened) return;
    // close it again, but only if it is still open
    const now = weOpened.isConnected ? { el: weOpened, open: chatButton(doc)?.open } : chatButton(doc);
    if (now?.open) now.el.click();
  };
  const finish = (r) => (restore(), r);

  if (input === 'off' || (input && !chatAllowed(doc))) return finish({ ok: false, why: 'chat is turned off in this meeting' });
  if (!input) return finish({ ok: false, why: 'could not find the chat box' });
  if (valueOf(input)) return finish({ ok: false, why: 'you have an unsent chat message' });
  if (alreadyPosted(doc, clean)) return finish({ ok: true, posted: false, why: 'already there' });

  putText(input, clean, win);
  const send = await until(() => sendButton(doc, input), 500, 50);
  if (send) send.click();
  else {
    for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new win.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  const sent = await until(() => !valueOf(input) || alreadyPosted(doc, clean), 1500, 100);
  if (!sent) {
    if (valueOf(input) === clean) clearText(input, win);
    return finish({ ok: false, why: 'the message did not send' });
  }
  return finish({ ok: true, posted: true });
}

export function diagnoseChat(doc) {
  const b = chatButton(doc);
  const input = chatInput(doc);
  return `button ${b ? 'found' : 'NOT found'}, panel ${b?.open || input ? 'open' : 'closed'}, input ${input ? 'found' : 'not found'}, ${input || b ? (chatAllowed(doc) ? 'allowed' : 'turned off') : 'allowed: unknown'}`;
}
