// Chat notice (Meet adapter) and the record reminder logic, on fake Meet markup. Real Meet could not be
// inspected, so this shows the logic works on the structure we expect, not that it works on live Meet.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const chat = await import('../src/adapters/chat.js');
const meet = await import('../src/adapters/meet.js');
const generic = await import('../src/adapters/generic.js');
const { shouldNudge, nudgeText } = await import('../src/nudge.js');
const fast = { wait: async () => {} };
const MSG = 'Debrief is recording this call to write the minutes.';

// a chat message: plain text (sender unknown), or { from, at, text, self } in Meet's grouping (sender and time, then the text)
const msgHtml = (h) => (typeof h === 'string' ? `<div>${h}</div>` : `<div class="grp"${h.self != null ? ` data-is-self="${h.self}"` : ''}>${h.from ? `<div><span>${h.from}</span><span>${h.at || '10:31'}</span></div>` : ''}<div><div>${h.text}</div></div></div>`);
// opts: closed (panel hidden until the button is clicked), kind 'textarea'|'ce', send (button), off, draft, history, decoys
function fake(o = {}) {
  const { kind = 'textarea', send = true, closed = true } = o;
  const dom = new JSDOM(`<!doctype html><body>
    <button aria-label="Leave call"></button><button data-is-muted="false" aria-label="Turn off microphone"></button>
    <button id="chatbtn" aria-label="Chat with everyone" aria-pressed="${closed ? 'false' : 'true'}"></button>
    <div id="slot"></div>${o.decoys ? '<div role="dialog" aria-label="Add people"><textarea aria-label="Add others"></textarea></div><div role="region" aria-label="Q&A"><textarea aria-label="Ask a question"></textarea></div>' : ''}</body>`);
  const win = dom.window;
  const doc = win.document;
  const btn = doc.getElementById('chatbtn');
  const sent = [];
  const send1 = (box) => {
    const v = kind === 'textarea' ? box.value : box.textContent;
    if (!v) return;
    sent.push(v);
    const m = doc.createElement('div');
    m.textContent = v;
    doc.getElementById('log').appendChild(m);
    if (kind === 'textarea') box.value = '';
    else box.textContent = '';
  };
  const build = () => {
    doc.getElementById('slot').innerHTML = `<div role="complementary" aria-label="In-call messages"><div id="log">${(o.history || []).map(msgHtml).join('')}</div>
      ${o.off ? '<div>Chat is turned off by the host</div>' : kind === 'textarea' ? '<textarea aria-label="Send a message"></textarea>' : '<div contenteditable="true" aria-label="Send a message"></div>'}
      ${send && !o.off ? '<button aria-label="Send a message" disabled></button>' : ''}</div>`;
    const box = doc.querySelector('[aria-label="Send a message"]:not(button)');
    if (box && o.draft) kind === 'textarea' ? (box.value = o.draft) : (box.textContent = o.draft);
    const sb = doc.querySelector('button[aria-label="Send a message"]');
    if (box) {
      box.addEventListener('input', () => sb && (sb.disabled = false));
      if (sb) sb.addEventListener('click', () => send1(box));
      box.addEventListener('keydown', (e) => !sb && e.key === 'Enter' && send1(box));
    }
  };
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!open));
    if (open) doc.getElementById('slot').innerHTML = '';
    else build();
  });
  if (!closed) build();
  return { doc, win, btn, sent, isOpen: () => btn.getAttribute('aria-pressed') === 'true' };
}

for (const kind of ['textarea', 'ce']) {
  await test(`notice (${kind}): closed panel opens, sends, closes again`, async () => {
    const f = fake({ kind });
    assert.deepEqual(await chat.postNotice(f.doc, MSG, fast), { ok: true, posted: true });
    assert.deepEqual(f.sent, [MSG]);
    assert.equal(f.isOpen(), false);
  });
  await test(`notice (${kind}): panel the user had open stays open`, async () => {
    const f = fake({ kind, closed: false });
    assert.equal((await chat.postNotice(f.doc, MSG, fast)).posted, true);
    assert.equal(f.isOpen(), true);
  });
  await test(`notice (${kind}): no send button -> Enter path`, async () => {
    const f = fake({ kind, send: false });
    assert.equal((await chat.postNotice(f.doc, MSG, fast)).posted, true);
    assert.deepEqual(f.sent, [MSG]);
  });
}

await test('notice: a draft the user typed is never overwritten', async () => {
  const f = fake({ draft: 'half a thought', closed: false });
  assert.deepEqual(await chat.postNotice(f.doc, MSG, fast), { ok: false, why: 'you have an unsent chat message' });
  assert.equal(f.doc.querySelector('textarea').value, 'half a thought');
  assert.deepEqual(f.sent, []);
});

await test('notice: chat turned off -> refuses and restores the panel', async () => {
  const f = fake({ off: true });
  assert.deepEqual(await chat.postNotice(f.doc, MSG, fast), { ok: false, why: 'chat is turned off in this meeting' });
  assert.equal(f.isOpen(), false);
});

await test('notice: already posted by me is not posted twice', async () => {
  for (const mine of [{ self: true, text: MSG }]) {
    const f = fake({ history: [{ from: 'Ravi', at: '10:30', text: 'hello' }, mine], closed: false });
    assert.equal(chat.alreadyPosted(f.doc, MSG), true, JSON.stringify(mine));
    assert.deepEqual(await chat.postNotice(f.doc, MSG, fast), { ok: true, posted: false, why: 'already there' });
    assert.deepEqual(f.sent, []);
  }
});

await test('notice L5: the same words pasted by someone else, or anywhere outside the chat, never hold back my notice', async () => {
  const cases = [
    [MSG], // sender unknown
    [{ from: 'Mallory', at: '10:29', text: MSG }],
    [{ from: 'Mallory', at: '10:29', text: 'You' }, { text: MSG }], // a message "You" is not a sender
    [{ from: 'Mallory', at: '10:29', text: MSG, self: false }],
    [{ from: 'You', at: '10:31', text: MSG }], // a visible "You" label is only a display name
    [{ from: 'You', at: '10:31 AM', text: MSG }],
    [{ from: 'You', at: '10:29', text: 'hi' }, { from: 'Mallory', at: '10:30', text: MSG }],
  ];
  for (const history of cases) {
    const f = fake({ history, closed: false });
    assert.equal(chat.alreadyPosted(f.doc, MSG), false, JSON.stringify(history));
    assert.deepEqual(await chat.postNotice(f.doc, MSG, fast), { ok: true, posted: true }, JSON.stringify(history));
    assert.deepEqual(f.sent, [MSG]);
  }
  // the words on the page outside the chat panel (a participant tile, a caption): the panel is what counts
  const f = fake();
  f.doc.body.insertAdjacentHTML('beforeend', `<div class="grp"><div><span>You</span><span>10:31</span></div><div><div>${MSG}</div></div></div>`);
  assert.equal(chat.alreadyPosted(f.doc, MSG), false, 'no chat panel: never the whole page');
  assert.equal((await chat.postNotice(f.doc, MSG, fast)).posted, true);
});

await test('notice: message that never sends -> fails and leaves no text behind', async () => {
  const f = fake({ closed: false, send: false });
  const box = f.doc.querySelector('textarea');
  const r = await chat.postNotice(f.doc, MSG, { ...fast, win: f.win });
  // this fake box ignores Enter only when a send button exists; here there is none and Enter does send, so break it:
  assert.equal(r.ok, true);
  const g = fake({ closed: false, send: false });
  g.doc.querySelector('textarea').addEventListener('keydown', (e) => e.stopImmediatePropagation(), true);
  const r2 = await chat.postNotice(g.doc, MSG, fast);
  assert.deepEqual(r2, { ok: false, why: 'the message did not send' });
  assert.equal(g.doc.querySelector('textarea').value, '');
  assert.ok(box);
});

await test('notice: not in a call', async () => {
  const dom = new JSDOM('<body><div>lobby</div></body>');
  assert.deepEqual(await chat.postNotice(dom.window.document, MSG, fast), { ok: false, why: 'not in a call' });
});

await test('notice: text is cleaned, cut to 300, and inserted as text only', async () => {
  const f = fake({ closed: false });
  assert.equal((await chat.postNotice(f.doc, '  \n\t ', fast)).ok, false);
  assert.equal((await chat.postNotice(f.doc, 42, fast)).ok, false);
  assert.equal(chat.cleanNotice('a\r\nb\u0007c\nd'), 'a bc d');
  assert.equal(chat.cleanNotice('x'.repeat(500)).length, 300);
  const evil = '<img src=x onerror=1>';
  assert.equal((await chat.postNotice(f.doc, evil, fast)).posted, true);
  assert.deepEqual(f.sent, [evil]);
  assert.equal(f.doc.querySelector('img'), null);
  assert.equal(f.doc.getElementById('log').textContent, evil);
});

await test('notice: selectors ignore Add people and Q&A boxes', () => {
  const f = fake({ decoys: true });
  assert.equal(chat.chatInput(f.doc), null, 'no chat box while the panel is closed');
  f.btn.click();
  assert.equal(chat.chatInput(f.doc).getAttribute('aria-label'), 'Send a message');
  const d = new JSDOM('<body><div role="dialog" aria-label="Add people"><textarea aria-label="Send a message to them"></textarea></div><div role="region" aria-label="Q&A"><textarea aria-label="Send message"></textarea></div></body>').window.document;
  assert.equal(chat.chatInput(d), null);
});

await test('notice: chat input fallback is the only textarea in a chat region', () => {
  const d = new JSDOM('<body><div role="region" aria-label="Chat"><textarea></textarea></div></body>').window.document;
  assert.ok(chat.chatInput(d));
  const two = new JSDOM('<body><div role="region" aria-label="Chat"><textarea></textarea><textarea></textarea></div></body>').window.document;
  assert.equal(chat.chatInput(two), null);
});

await test('notice: chat button reports open or closed', () => {
  const o = (h) => chat.chatButton(new JSDOM(`<body>${h}</body>`).window.document);
  assert.equal(o('<button aria-label="Chat with everyone" aria-pressed="false"></button>').open, false);
  assert.equal(o('<button aria-label="Chat with everyone" aria-expanded="true"></button>').open, true);
  assert.equal(o('<button aria-label="Close chat"></button>').open, true);
  assert.equal(o('<div id="p" aria-label="Chat panel"></div><button aria-label="Panel" aria-controls="p"></button>').open, false);
  assert.equal(o('<button aria-label="Mute"></button>'), null);
});

await test('notice: diagnose has a chat line; generic refuses; meet adapter wraps', async () => {
  const f = fake({ closed: false });
  assert.match(meet.diagnose(f.doc).chat, /button found, panel open, input found, allowed/);
  assert.match(meet.diagnose(fake().doc).chat, /panel closed/);
  assert.deepEqual(await generic.postNotice(f.doc, MSG), { ok: false, why: 'not supported in this meeting app' });
  assert.equal((await meet.postNotice(f.doc, MSG, fast)).posted, true);
});

// ---- nudge ----
const types = [{ name: 'Daily stand-up', match: 'stand-up, standup' }];
const base = { settings: { meetingTypes: types }, title: 'Daily stand-up', url: 'https://meet.google.com/abc-defg-hij', participants: ['A', 'B', 'C'], recording: false, now: 1e12 };

await test('nudge: matches a type and nudges', () => {
  const r = shouldNudge(base);
  assert.equal(r.nudge, true);
  assert.equal(r.typeName, 'Daily stand-up');
  assert.equal(r.key, 'meet:abc-defg-hij');
});
await test('nudge: off, recording, no match, dismissed', () => {
  assert.equal(shouldNudge({ ...base, settings: { ...base.settings, recordNudge: false } }).nudge, false);
  assert.equal(shouldNudge({ ...base, recording: true }).reason, 'already recording');
  assert.equal(shouldNudge({ ...base, title: 'Lunch', url: 'https://meet.google.com/zzz-yyyy-xxx' }).nudge, false);
  assert.equal(shouldNudge({ ...base, dismissedKeys: ['meet:abc-defg-hij'] }).nudge, false);
});
await test('nudge: one-on-one skipped, unless the setting is off', () => {
  assert.equal(shouldNudge({ ...base, participants: ['A', 'B'] }).reason, 'one-on-one');
  assert.equal(shouldNudge({ ...base, participants: ['A'] }).nudge, false);
  assert.equal(shouldNudge({ ...base, participants: ['A', 'B'], settings: { ...base.settings, nudgeSkipOneOnOne: false } }).nudge, true);
});
await test('nudge: waits 20 s for the participant list', () => {
  const j = { ...base, participants: [], joinedAt: base.now - 10000 };
  assert.equal(shouldNudge(j).reason, 'waiting for participants');
  assert.equal(shouldNudge({ ...j, joinedAt: base.now - 20000 }).nudge, true);
});
await test('nudge: key is the Meet code, else title + day', () => {
  assert.match(shouldNudge({ ...base, url: 'https://example.com/x' }).key, /^title:daily stand-up:2001-09-09$/);
});
await test('nudge: text is one honest line', () => {
  assert.equal(nudgeText('Daily stand-up', 'Alt+Shift+M'), 'This looks like your "Daily stand-up". Press Alt+Shift+M or click the Debrief button to record it.');
});

console.log(`\n${passed} passed`);
