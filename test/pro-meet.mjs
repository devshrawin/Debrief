// Page readers (Meet and generic), checked against hand-made pages shaped like the real ones.
// Meet's real markup could not be inspected for these tests, so they show the logic works on the
// structure we expect; the "Check page detection" link in the popup shows what a live page gives.
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

// jsdom has no innerText; mirror it from textContent with line breaks between block elements.
function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      const walk = (n) => (n.nodeType === 3 ? n.textContent : [...n.childNodes].map(walk).join(n.tagName === 'DIV' || n.tagName === 'LI' || n.tagName === 'P' ? '\n' : ''));
      return walk(this).replace(/\n{2,}/g, '\n').trim();
    },
  });
  return window.document;
}

const meet = await import('../src/adapters/meet.js');
const generic = await import('../src/adapters/generic.js');
const { adapterFor, OTHER_SITES } = await import('../src/adapters/index.js');

await test('meet: mic button state from data-is-muted, with a label fallback', () => {
  assert.deepEqual(meet.micButton(page('<button data-is-muted="true" aria-label="Turn on microphone (ctrl + d)"></button>')) && { m: meet.micButton(page('<button data-is-muted="true" aria-label="Turn on microphone (ctrl + d)"></button>')).muted }, { m: true });
  assert.equal(meet.micButton(page('<button data-is-muted="false" aria-label="Turn off microphone (ctrl + d)"></button>')).muted, false);
  assert.equal(meet.micButton(page('<button aria-label="Turn on microphone"></button>')).muted, true);
  assert.equal(meet.micButton(page('<button data-is-muted="true" aria-label="Turn off camera"></button>')), null, 'the camera button is not the mic');
  assert.equal(meet.micButton(page('<div>nothing</div>')), null);
});

await test('meet: participants from video tiles, ignoring labels and badges', () => {
  const doc = page(`
    <div data-participant-id="a"><div>Amal Raj</div><div>Mute</div></div>
    <div data-participant-id="b"><div data-self-name="Shrawin Sisodiya">You</div></div>
    <div data-participant-id="c"><div>Presenting</div><div>Priya Nair</div></div>
    <div data-participant-id="d"><div>+3</div></div>`);
  assert.deepEqual(meet.readParticipants(doc).sort(), ['Amal Raj', 'Priya Nair', 'Shrawin Sisodiya']);
});

await test('meet: participants from the People panel when it is open', () => {
  const doc = page(`
    <div data-participant-id="a"><div>Tile Only</div></div>
    <div role="list" aria-label="Participants">
      <div role="listitem" aria-label="Amal Raj"><div>Amal Raj</div></div>
      <div role="listitem"><div>Ravi Kumar (You)</div></div>
      <div role="listitem" aria-label="Priya Nair"></div>
    </div>`);
  assert.deepEqual(meet.readParticipants(doc), ['Amal Raj', 'Ravi Kumar', 'Priya Nair']);
});

await test('meet: live captions give speaker name and text, skipping duplicates', () => {
  const doc = page(`
    <div role="region" aria-label="Captions">
      <div><img alt=""><div>Amal Raj</div><div>We will ship on Friday.</div></div>
      <div><div>Priya Nair</div><div>Can you share the file?</div></div>
    </div>`);
  assert.deepEqual(meet.readCaptions(doc), [
    { name: 'Amal Raj', text: 'We will ship on Friday.' },
    { name: 'Priya Nair', text: 'Can you share the file?' },
  ]);
  assert.deepEqual(meet.readCaptions(page('<div>no captions</div>')), []);
  assert.ok(meet.captionsButton(page('<button aria-label="Turn on captions (c)"></button>')));
});

await test('meet: end screen detection and the diagnostic report', () => {
  assert.equal(meet.endScreen(page('<h1>You left the meeting</h1><button>Rejoin</button>')), true);
  assert.equal(meet.endScreen(page('<button aria-label="Leave call">Leave call</button><div>chat: you left the meeting notes</div>')), false);
  const d = meet.diagnose(page('<button data-is-muted="false" aria-label="Turn off microphone"></button><div data-participant-id="a"><div>Amal Raj</div></div>'));
  assert.match(d.micButton, /found, unmuted/);
  assert.match(d.participants, /1 found: Amal Raj/);
  assert.match(d.captions, /not showing/);
});

await test('generic: mic and end screen on other meeting apps', () => {
  assert.equal(generic.micButton(page('<button aria-label="Unmute"></button>')).muted, true);
  assert.equal(generic.micButton(page('<button aria-label="Mute"></button>')).muted, false);
  assert.equal(generic.micButton(page('<button aria-label="Mute camera"></button><button aria-label="Turn off microphone"></button>')).muted, false);
  assert.equal(generic.micButton(page('<button aria-label="Turn on camera"></button>')), null);
  assert.equal(generic.endScreen(page('<h2>You left the meeting</h2>')), true);
  assert.equal(generic.endScreen(page('<h1>The meeting has ended</h1>')), true);
  assert.equal(generic.endScreen(page('<div>Weekly sync</div><button>Mute</button>')), false);
  assert.match(generic.diagnose(page('<button aria-label="Mute"></button>'), 'Zoom').app, /experimental/);
});

await test('adapters: the right reader is chosen per site', () => {
  assert.equal(adapterFor('meet.google.com').id, 'meet');
  assert.equal(adapterFor('meet.google.com').hasPeople, true);
  assert.equal(adapterFor('teams.microsoft.com').name, 'Microsoft Teams');
  assert.equal(adapterFor('app.zoom.us').name, 'Zoom (web client)');
  assert.equal(adapterFor('acme.webex.com').name, 'Webex');
  assert.equal(adapterFor('example.com').id, 'generic');
  assert.ok(OTHER_SITES.length >= 5);
});

console.log(`\n${passed} passed`);
