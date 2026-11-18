// Security regressions (audit 2, B1-B3, B6-B9): minutes HTML never carries a tag from the stored text, Slack/Teams digests
// cannot ping or link, a backup file cannot switch on retention or capture or bring keys without a tick, names from the
// page cannot pollute prototypes, only the recorded tab can mute the mic, a participant called "You" cannot silence the
// chat notice, and audio that never transcribed expires.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 5).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const { send, state } = await import('./bg-harness.mjs'); // installs a fake chrome and loads the service worker
const BG = await import('../src/background.js');
const O = await import('../src/orgtemplate.js');
const { buildEmail, wordDocHtml } = await import('../src/mailer.js');
const { renderMd } = await import('../src/md.js');
const W = await import('../src/webhook.js');
const B = await import('../src/backup.js');
const S = await import('../src/store.js');
const AS = await import('../src/audiostore.js');
const { cleanPresence } = await import('../src/iconText.js');
const { voicePresence } = await import('../src/voice/match.js');
const chat = await import('../src/adapters/chat.js');

// ---------------------------------------------------------------- B1: nothing from the minutes is HTML
const EVIL1 = '<meta http-equiv=refresh content="0;url=https://evil.example/"><script>alert(1)</script>';
const EVIL2 = '"><img src=x onerror=alert(2)>';
const e1 = (w) => `${EVIL1}${w}`;
const e2 = (w) => `${EVIL2}${w}`;
const TPL = `<!-- debrief-format: template -->
# ${e1('Title')}

## Meeting details
| Field | Value |
|---|---|
| Topic | ${e1('Topic')} |
| Mode | ${e2('Mode')} |
| Location | ${e1('Place')} |
| Date | ${e2('Date')} |
| Time | ${e1('Time')} |
| Chairperson | ${e2('Chair')} |

## Attendees – Client Side (${e1('ClientOrg')})
| SR | Name | Designation | Department |
|---|---|---|---|
| 1 | ${e2('Pname')} | ${e1('Pdes')} | ${e2('Pdept')} |

## Attendees – System Integrator (${e2('SiOrg')})
| SR | Name | Designation | Department |
|---|---|---|---|
| 1 | ${e1('Sname')} | ${e2('Sdes')} | ${e1('Sdept')} |

## Agenda
- ${e1('Agenda')}

## Discussion
| SR | Topic | Points | Resp |
|---|---|---|---|
| 1 | ${e2('DTopic')} | ${e1('DPoints')} | ${e2('DResp')} |

## Updates by person
| SR | Name | ${e1('Hdr1')} | ${e2('Hdr2')} |
|---|---|---|---|
| 1 | ${e1('UName')} | ${e2('Cell1')} | ${e1('Cell2')} |

## Action Items
| Sr | Action | Resp |
|---|---|---|
| 1 | ${e2('Act')} | ${e1('ActResp')} |

## Next Meeting
Date and Time: ${e1('NextWhen')}
Location: ${e2('NextWhere')}

## Notes
- ${e1('Note')}
`;
const tags = (html) => (html.match(/<(meta|script|img)\b[^>]*>/gi) || []).filter((t) => !/^<meta charset=/i.test(t));

await test('B1: every field of a template meeting is escaped in the minutes page, the A4 download, Word and the email', () => {
  O.setOrg({ orgName: e1('OrgName'), orgConfidential: e2('Conf') });
  const doc = O.parseTemplateMarkdown(TPL);
  assert.ok(doc, 'the evil minutes still parse as a template');
  assert.ok(doc.updates?.rows?.length, 'updates table parsed');
  const outs = {
    renderPrintFragment: O.renderPrintFragment(doc),
    renderStandaloneHtml: O.renderStandaloneHtml(doc),
    renderWordHtml: O.renderWordHtml(doc),
    renderPdfHtml: O.renderPdfHtml(doc),
    renderEmailCover: O.renderEmailCover(doc, { attached: [] }),
    wordDocHtml: wordDocHtml('', { md: TPL }),
  };
  const mail = buildEmail({ title: e1('MTitle'), startedAt: 1_700_000_000_000, endedAt: 1_700_000_600_000, mom: TPL, model: e2('Model') }, { emailPdf: false, emailWord: false, orgName: 'X' }, renderMd, '');
  outs.emailInline = mail.html;
  for (const att of buildEmail({ title: 't', startedAt: 1_700_000_000_000, mom: TPL }, { emailPdf: true, emailWord: true }, renderMd, '').attachments) {
    if (att.fromHtml) outs.pdfAttachment = att.fromHtml;
    else if (att.mime === 'application/msword') outs.wordAttachment = Buffer.from(att.base64, 'base64').toString('utf8');
  }
  for (const [name, html] of Object.entries(outs)) {
    assert.deepEqual(tags(html), [], `${name} carries a tag from the minutes: ${tags(html).join(' ')}`);
    assert.ok(!/<[a-z]+[^>]*\sonerror=/i.test(html), `${name} has an event handler attribute`);
  }
  assert.ok(outs.renderPrintFragment.includes('Hdr1') && outs.renderPrintFragment.includes('Cell2'), 'the text is still shown, as text');
  O.setOrg({});
});

await test('B1: the same for the standard (non-template) minutes email and PDF page', () => {
  const mom = `# T\n\n${EVIL1}\n\n| a | ${EVIL2} |\n|---|---|\n| ${EVIL1} | b |\n`;
  const m = buildEmail({ title: e1('MT'), startedAt: 1_700_000_000_000, mom, model: e2('M') }, { emailPdf: true }, renderMd, '');
  assert.deepEqual(tags(m.html), []);
  for (const a of m.attachments) if (a.fromHtml) assert.deepEqual(tags(a.fromHtml), []);
});

await test('B1: the extension pages cannot be framed, submit a form or change <base>', () => {
  const csp = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).content_security_policy.extension_pages;
  for (const d of ["form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'self'"]) assert.ok(csp.includes(d), `${d} in: ${csp}`);
  assert.ok(!/unsafe-inline|unsafe-eval(?!\b.*wasm)|script-src[^;]*http/.test(csp.replace("'wasm-unsafe-eval'", '')), 'scripts stay local only');
  for (const f of ['popup.html', 'mom.html', 'options.html']) {
    let h = '';
    try {
      h = readFileSync(new URL(`../extension/${f}`, import.meta.url), 'utf8');
    } catch {}
    assert.ok(!/<iframe|<frame\b|<base\b|<form\b/i.test(h), `${f} uses a frame, base or form`);
  }
});

// ---------------------------------------------------------------- B2: chat digests
await test('B2: a Slack/Teams digest cannot ping, link elsewhere or carry markup', () => {
  const m = {
    title: '<!channel> Weekly <https://evil.example|click here> sync',
    startedAt: 1_700_000_000_000,
    items: {
      overview: 'See [the plan](https://evil.example/x) and ![pic](https://evil.example/i.png) @channel @here @everyone <!everyone> <@U123> a<b>c & d',
      decisions: [{ text: '<!here> ship [now](javascript:alert(1))' }],
      actions: [{ text: 'tell @everyone', owner: '<!subteam^S1|devs>', due: '<https://evil.example>' }],
    },
  };
  const d = W.chatDigest(m);
  assert.ok(!/<!|@channel|@here|@everyone|\]\(|https:\/\/evil\.example\//i.test(d), d);
  assert.ok(!/<(?!\/?\w)|<[a-z@!]/i.test(d.replace(/&lt;|&gt;|&amp;/g, '')), 'no raw < or > left');
  assert.ok(d.includes('click here') && d.includes('the plan') && d.includes('ship now'), 'visible text is kept');
  assert.ok(d.includes('&amp;') && d.includes('&lt;'), 'what is left is entity-escaped');
});

// ---------------------------------------------------------------- B3: backup ticks
const ASK = ['keepAudio', 'keepAudioDays', 'voiceLearn', 'voiceSamples', 'voiceOn', 'autoStop', 'autoStopQuietMin', 'meetCaptions', 'captureMic', 'recordNudge', 'screenNotes', 'consentNotice'];
await test('B3: retention and capture settings are ticked items with plain labels', () => {
  for (const k of ASK) {
    assert.ok(B.ROUTING_SETTINGS.includes(k), `${k} needs a tick`);
    assert.match(B.ROUTING_LABELS[k], /^[A-Z][a-z' ]/);
  }
  assert.ok(B.ROUTING_SETTINGS.includes('apiKeys'));
  assert.equal(B.ROUTING_LABELS.apiKeys, 'Use the API keys from this file');
});

const FILE = () => ({ app: 'debrief', version: 1, schema: S.SCHEMA, settings: { keepAudio: true, keepAudioDays: 0, voiceLearn: true, voiceOn: true, voiceSamples: false, autoStop: false, autoStopQuietMin: 0, meetCaptions: 'auto', captureMic: false, recordNudge: false, geminiKey: 'G-FILE', sttKey: 'T-FILE', momLanguage: 'Hindi' } });
await test('B3: a file cannot switch on retention or capture, or bring keys, without a tick (merge and replace)', async () => {
  for (const mode of ['merge', 'replace']) {
    state.mem.local = { schema: S.SCHEMA, settings: {} };
    state.mem.session = {};
    const p = await B.previewImport(FILE());
    const keys = p.routing.map((r) => r.key);
    for (const k of ['keepAudio', 'keepAudioDays', 'voiceLearn', 'voiceOn', 'voiceSamples', 'autoStop', 'autoStopQuietMin', 'meetCaptions', 'captureMic', 'recordNudge', 'apiKeys']) assert.ok(keys.includes(k), `${mode}: ${k} is offered as a tick`);
    await B.importAll(FILE(), { mode });
    const s = await S.getSettings();
    for (const k of ASK) assert.deepEqual(s[k], S.DEFAULTS[k], `${mode}: ${k} unchanged without a tick`);
    assert.equal(s.geminiKey || '', '', `${mode}: no key from the file`);
    assert.equal(s.sttKey || '', '');
    assert.equal(s.momLanguage, 'Hindi', `${mode}: an ordinary setting is still taken`);
  }
});

await test('B3: ticked items and "Use the API keys from this file" are applied', async () => {
  state.mem.local = { schema: S.SCHEMA, settings: {} };
  await B.importAll(FILE(), { acceptRouting: ['keepAudio', 'keepAudioDays', 'apiKeys'] });
  const s = await S.getSettings();
  assert.equal(s.keepAudio, true);
  assert.equal(s.keepAudioDays, 0);
  assert.equal(s.geminiKey, 'G-FILE');
  assert.equal(s.sttKey, 'T-FILE');
  assert.equal(s.voiceLearn, false, 'not ticked: not taken');
});

// ---------------------------------------------------------------- B6: names from the page
await test('B6: a participant named __proto__ or constructor pollutes nothing and is kept like anyone else', async () => {
  state.mem.local = {};
  state.mem.session = { rec: { recording: true, meetingId: 'mt', tabId: 7, startedAt: Date.now() - 5000, mic: true, micOn: true, micWanted: true, meetMuted: null } };
  state.mem.local['meeting:mt'] = { id: 'mt', title: 'T', startedAt: Date.now() - 5000, endedAt: null, segments: [], errors: [], mom: '' };
  state.mem.local.meetingIds = ['mt'];
  const MEET = { id: 'testid', tab: { id: 7 }, url: 'https://meet.google.com/abc-defg-hij' };
  await send({ type: 'meet-snap', t: 5, names: ['__proto__', 'constructor', 'Amal'], captions: [{ name: '__proto__', text: 'hi', t: 5 }] }, MEET);
  await send({ type: 'meet-snap', t: 9, names: ['__proto__', 'constructor'], captions: [] }, MEET);
  await send({ type: 'stop' }, { id: 'testid', url: 'chrome-extension://testid/popup.html' });
  const { getMeeting } = S;
  const m = await getMeeting('mt');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.deepEqual(Object.keys(m.presence).sort(), ['Amal', '__proto__', 'constructor']);
  assert.deepEqual(m.presence.constructor, [5, 9, 2]);
  assert.deepEqual(m.presence.__proto__, [5, 9, 2]);
  assert.equal(m.captions[0].name, '__proto__');
});

await test('B6: names are capped at 300 per meeting and 60 characters each', async () => {
  state.mem.local = {};
  state.mem.session = { rec: { recording: true, meetingId: 'mt2', tabId: 7, startedAt: Date.now() - 5000, mic: true, micOn: true, micWanted: true, meetMuted: null } };
  state.mem.local['meeting:mt2'] = { id: 'mt2', title: 'T', startedAt: Date.now() - 5000, endedAt: null, segments: [], errors: [], mom: '' };
  state.mem.local.meetingIds = ['mt2'];
  const MEET = { id: 'testid', tab: { id: 7 }, url: 'https://meet.google.com/abc-defg-hij' };
  for (let i = 0; i < 700; i += 100) await send({ type: 'meet-snap', t: 1, names: Array.from({ length: 100 }, (_, k) => `Person ${i + k}`), captions: [] }, MEET);
  await send({ type: 'meet-snap', t: 2, names: ['x'.repeat(500), 7, null, { a: 1 }], captions: [{ name: 'y'.repeat(500), text: 't', t: 2 }] }, MEET);
  await send({ type: 'stop' }, { id: 'testid', url: 'chrome-extension://testid/popup.html' });
  const m = await S.getMeeting('mt2');
  const names = Object.keys(m.presence);
  assert.ok(names.length <= 300, `${names.length} names`);
  assert.ok(names.every((n) => n.length <= 60));
});

await test('B6: attendance and voice presence keep a name called __proto__ or constructor as an ordinary entry', () => {
  const p = cleanPresence(JSON.parse('{"__proto__":[1,5,2],"constructor":[2,6,1],"Amal":[0,3,1]}'));
  assert.deepEqual(Object.keys(p).sort(), ['Amal', '__proto__', 'constructor']);
  assert.deepEqual(p.constructor, [2, 6, 1]);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(({}).length, undefined);
  const v = voicePresence([{ name: '__proto__', t: 1, text: 'hello there' }, { name: 'constructor', t: 2, text: 'hello there' }, { name: '__proto__', t: 8, text: 'again' }]);
  assert.deepEqual(Object.keys(v).sort(), ['__proto__', 'constructor']);
  assert.equal(v.constructor[2], 1);
  assert.equal(Object.getOwnPropertyDescriptor(v, '__proto__').value[2], 2);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
});

// ---------------------------------------------------------------- B7: meet-mute
await test('B7: meet-mute is for the recorded tab only, and only a boolean or null', async () => {
  assert.ok(BG.RECORDED_TAB_ONLY.has('meet-mute'));
  state.mem.local = {};
  state.mem.session = { rec: { recording: true, meetingId: 'mt3', tabId: 7, startedAt: Date.now() - 5000, mic: true, micOn: true, micWanted: true, meetMuted: null } };
  state.mem.local['meeting:mt3'] = { id: 'mt3', title: 'T', startedAt: Date.now() - 5000, endedAt: null, segments: [], errors: [], mom: '' };
  state.mem.local.meetingIds = ['mt3'];
  const other = { id: 'testid', tab: { id: 9 }, url: 'https://meet.google.com/zzz-zzzz-zzz' };
  const rec = { id: 'testid', tab: { id: 7 }, url: 'https://meet.google.com/abc-defg-hij' };
  assert.deepEqual(await send({ type: 'meet-mute', muted: true }, other), { ok: false });
  assert.equal(state.mem.session.rec.meetMuted, null, 'another tab cannot mute the recorded meeting');
  for (const bad of ['true', 1, {}, undefined, 'yes']) {
    assert.deepEqual(await send({ type: 'meet-mute', muted: bad }, rec), { ok: false }, JSON.stringify(bad));
    assert.equal(state.mem.session.rec.meetMuted, null);
  }
  assert.equal((await send({ type: 'meet-mute', muted: true }, rec)).ok, true);
  assert.equal(state.mem.session.rec.meetMuted, true);
  assert.equal((await send({ type: 'meet-mute', muted: null }, rec)).ok, true);
  assert.equal(state.mem.session.rec.meetMuted, null);
});

// ---------------------------------------------------------------- B8: a participant named "You"
const MSG = 'Debrief is recording this call to write the minutes.';
await test('B8: a visible sender "You" (or an aria label equal to a name) never counts as my own message', () => {
  const mk = (inner) => {
    const dom = new JSDOM(`<!doctype html><body><button aria-label="Leave call"></button><div role="complementary" aria-label="In-call messages"><div>${inner}</div><textarea aria-label="Send a message"></textarea><button aria-label="Send a message"></button></div></body>`);
    return dom.window.document;
  };
  const you = mk(`<div class="grp"><div><span>You</span><span>10:31</span></div><div><div>${MSG}</div></div></div>`);
  assert.equal(chat.alreadyPosted(you, MSG), false, 'a label "You" is a display name');
  const you2 = mk(`<div class="grp"><div><span>You</span><span>10:31 AM</span></div><div><div>${MSG}</div></div></div>`);
  assert.equal(chat.alreadyPosted(you2, MSG), false);
  const mine = mk(`<div class="grp" data-is-self="true"><div><span>Mallory</span><span>10:31</span></div><div><div>${MSG}</div></div></div>`);
  assert.equal(chat.alreadyPosted(mine, MSG), true, "Meet's own marker still counts");
});

// ---------------------------------------------------------------- B9: purge timing and pending audio
await test('B9: audio that never transcribed is dropped after 30 days, in the same purge', async () => {
  const now = Date.now();
  const wav = new Blob(['x']);
  await AS.savePending({ meetingId: 'pa', src: 'others', t: 1, wav, error: 'x' });
  await AS.savePending({ meetingId: 'pa', src: 'others', t: 2, wav, error: 'x' });
  assert.equal((await AS.listPending('pa')).length, 2);
  state.mem.local = { settings: { keepAudioDays: 14 } };
  state.mem.session = {};
  assert.equal(await BG.purgeKeptAudio(now + 10 * 86400000), 0);
  assert.equal((await AS.listPending('pa')).length, 2, 'ten days: kept');
  state.mem.session = {};
  await BG.purgeKeptAudio(now + 31 * 86400000);
  assert.equal((await AS.listPending('pa')).length, 0, 'older than 30 days: gone');
});

await test('B9: keptPurgedAt is set only after a purge worked, and a changed keepAudioDays purges at once', async () => {
  const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function purgeKeptAudio'), src.indexOf('purgeKeptAudio().catch'));
  assert.ok(body.indexOf('await purgeOld(') < body.indexOf("keptPurgedAt: now"), 'stamped after the purge');
  // the setting changes: the listener runs a forced purge
  const K = await import('../src/audiokeep.js');
  const now = Date.now();
  await K.putSeg({ meetingId: 'ko', seq: 0, t0: 0, dur: 30, blob: null, savedAt: now - 20 * 86400000 });
  state.mem.local = { settings: { keepAudioDays: 30 } };
  state.mem.session = { keptPurgedAt: now }; // purged a moment ago: the 6-hour rule would wait
  assert.equal((await K.listSegs('ko')).length, 1);
  state.mem.local.settings = { keepAudioDays: 7 };
  for (const f of globalThis.__changed || []) f({ settings: { oldValue: { keepAudioDays: 30 }, newValue: { keepAudioDays: 7 } } }, 'local');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await K.listSegs('ko')).length, 0, 'shortened days: purged right away');
  await K.deleteAudio('ko');
});

await test('B9: PRIVACY.md says failed-to-transcribe audio stays until retried, deleted or 30 days', () => {
  const t = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
  assert.match(t, /could not be transcribed[\s\S]*30 days/i);
});

console.log(`\n${passed} passed`);
