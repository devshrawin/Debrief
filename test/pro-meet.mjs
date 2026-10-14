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


await test('in-call detection: Zoom-like page, Meet lobby vs call, and the end screen', () => {
  const zoomCall = page('<footer><button aria-label="mute my microphone"></button><button aria-label="stop my video"></button><button>Leave</button></footer>');
  assert.equal(generic.inCall(zoomCall), true);
  assert.equal(generic.micButton(zoomCall).muted, false);
  assert.equal(generic.inCall(page('<button aria-label="unmute my microphone"></button><button>Leave</button>')), true);
  assert.equal(generic.inCall(page('<button aria-label="Join audio"></button><button>Join</button>')), false, 'a lobby is not a call');
  assert.equal(generic.inCall(page('<h2>You left the meeting</h2><button>Rejoin</button>')), false, 'end screen');
  assert.equal(generic.endScreen(page('<h2>You left the meeting</h2><button>Rejoin</button>')), true);
  assert.equal(generic.endScreen(page('<button aria-label="mute"></button><button>Leave</button><h2>Meeting ended notes</h2><button>Rejoin</button>')), false, 'while the call controls are on the page the call is not over');
  assert.equal(generic.inCall(page('<button aria-label="Mute"></button><div>Send message</div><button>Send</button>')), false, 'Send is not End');
  assert.equal(meet.inCall(page('<button data-is-muted="false" aria-label="Turn off microphone"></button><button aria-label="Leave call"></button>')), true);
  assert.equal(meet.inCall(page('<button data-is-muted="false" aria-label="Turn off microphone"></button><button>Join now</button>')), false);
  assert.match(meet.diagnose(page('<button data-is-muted="false" aria-label="Turn off microphone"></button><button aria-label="Leave call"></button>')).inCall, /yes/);
});


await test('popular meeting apps are covered by the page script from install', async () => {
  const fsx = await import('node:fs');
  const manifest = JSON.parse(fsx.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const matches = manifest.content_scripts[0].matches;
  for (const m of ['https://meet.google.com/*', 'https://app.zoom.us/*', 'https://*.zoom.us/wc/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://*.webex.com/*', 'https://whereby.com/*', 'https://meet.jit.si/*', 'https://app.goto.com/*', 'https://app.bluejeans.com/*', 'https://app.chime.aws/*', 'https://meeting.zoho.in/*', 'https://web.skype.com/*']) {
    assert.ok(matches.includes(m), `${m} missing from the manifest`);
  }
  for (const site of OTHER_SITES) for (const m of site.matches) assert.ok(matches.includes(m), `${site.name}: ${m} is not in the manifest`);
  const { adapterFor: af, isMeetingSite, siteFor } = await import('../src/adapters/index.js');
  assert.equal(af('us02web.zoom.us').name, 'Zoom (web client)');
  assert.equal(af('app.zoom.us').name, 'Zoom (web client)');
  assert.equal(af('acme.webex.com').name, 'Webex');
  assert.equal(af('meeting.zoho.in').name, 'Zoho Meeting');
  assert.equal(isMeetingSite('meet.google.com'), true);
  assert.equal(isMeetingSite('teams.microsoft.com'), true);
  assert.equal(isMeetingSite('example.com'), false);
  assert.equal(siteFor('notzoom.us'), null);
  assert.equal(generic.inCall(page('<button data-tid="toggle-mute" aria-label="Mute mic"></button><button data-tid="hangup-button" aria-label="Leave"></button>')), true, 'Teams-like call');
});

await test('meet: icon-font names (frame_person, keep_off, zoom_in...) are never read as participants', async () => {
  const doc = page(`
    <div data-participant-id="a"><div>Amal Raj</div><div>frame_person</div><div>keep_off</div></div>
    <div data-participant-id="b"><span>keep_outline</span><span>zoom_in</span></div>
    <div data-participant-id="c"><div>more_vert</div><div>Priya Nair</div></div>`);
  assert.deepEqual(meet.readParticipants(doc).sort(), ['Amal Raj', 'Priya Nair']);
  const { cleanPresence, isIconText } = await import('../src/iconText.js');
  assert.ok(['frame_person', 'keep_off', 'keep_outline', 'zoom_in', 'push_pin'].every(isIconText));
  assert.ok(!['Amal Raj', 'Mary-Ann', "D'Souza", 'o_connor', 'Ravi K.'].some((n) => n !== 'o_connor' && isIconText(n)));
  // meetings saved before the fix still show clean names
  const { attendanceMarkdown } = await import('../src/attendance.js');
  const md = attendanceMarkdown({ invited: [], presence: { 'Akash Behera': [0, 300, 5], frame_person: [0, 300, 5], zoom_in: [0, 10, 1] }, durationSec: 420, entries: [], myName: '' });
  assert.ok(/Akash Behera/.test(md) && !/frame_person|zoom_in/.test(md), md);
  assert.deepEqual(Object.keys(cleanPresence({ a_b: [1], Real: [1] })), ['Real']);
});

await test('meet: the mic button is found when Meet is in another language, and the camera is never taken for it', () => {
  const hindi = page('<button data-is-muted="false" aria-label="\u092e\u093e\u0907\u0915 \u092c\u0902\u0926 \u0915\u0930\u0947\u0902"></button><button data-is-muted="true" aria-label="\u0915\u0948\u092e\u0930\u093e \u091a\u093e\u0932\u0942 \u0915\u0930\u0947\u0902"></button>');
  assert.equal(meet.micButton(hindi).muted, false);
  const english = page('<button data-is-muted="true" aria-label="Turn on camera"></button><button data-is-muted="false" aria-label="Turn off microphone (ctrl + d)"></button>');
  assert.equal(meet.micButton(english).muted, false);
  const cameraOnly = page('<button data-is-muted="true" aria-label="Turn on camera"></button><button data-is-muted="true" aria-label="Turn off video"></button>');
  assert.equal(meet.micButton(cameraOnly), null);
});

console.log(`\n${passed} passed`);
