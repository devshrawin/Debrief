// Real Chrome: the 1.4 Settings controls. Every new control exists, has a name, loads its default, saves under the right key
// with the right type; dependents follow their switch; numbers clamp; the webhook address is checked; backup and restore work;
// "Check model names" reports a missing model and "Use <id>" fills the field; no page scrolls sideways or logs an error.
// A copy of the extension that already holds 127.0.0.1 is loaded, so the permission prompt resolves at once.
// Usage: node test/chrome-settings.mjs   (SHOTS=<dir> also writes full-page screenshots, light and dark, at 1280 and 420 px)
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const work = mkdtempSync(path.join(tmpdir(), 'debrief-settings-'));
const EXT = path.join(work, 'ext');
cpSync(path.resolve('extension'), EXT, { recursive: true });
const mf = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mf.host_permissions.push('http://127.0.0.1/*');
writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf));
const profile = path.join(work, 'profile');
const downloads = path.join(work, 'downloads');
mkdirSync(downloads);

// A receiver for the webhook test, and a stand-in for an OpenAI-compatible server (its model list).
const hits = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/hook')) {
      hits.push({ method: req.method, body });
      res.statusCode = req.url.includes('fail') ? 404 : 200;
      return res.end('ok');
    }
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'llama-3' }] }));
    }
    res.statusCode = 404;
    res.end();
  });
}).listen(0);
const port = server.address().port;

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const out = proc.stdio[3];
const inp = proc.stdio[4];
let nextId = 1;
const pending = new Map();
const listeners = [];
let buf = '';
inp.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else listeners.forEach((l) => l(msg));
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];
listeners.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(`${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});

let failed = false;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};

async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(1500);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, sessionId, ev };
}

const SHOTS = process.env.SHOTS;
const PAGES = ['start', 'general', 'speech', 'minutes', 'email', 'voices'];

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const pg = await openPage(`chrome-extension://${id}/options.html`);
  const { ev } = pg;
  const tab = async (name) => {
    await ev(`document.querySelector('#nav [data-tab="${name}"]').click()`);
    await sleep(150);
  };
  const saved = () => ev(`chrome.storage.local.get('settings').then((r) => r.settings || {})`);
  const save = async () => {
    await ev(`document.getElementById('save').click()`);
    await sleep(700);
  };
  const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const setVal = (sel, v) => ev(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const tick = (sel, on) => ev(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (f.checked !== ${on}) f.click(); })()`);
  const get = (sel, prop = 'value') => ev(`document.querySelector(${JSON.stringify(sel)})[${JSON.stringify(prop)}]`);

  // ---- 1. every new control: exists, has an accessible name and a hint, loads its default ----
  const SWITCHES = { recordNudge: true, nudgeSkipOneOnOne: true, consentNotice: false, keepAudio: false, screenNotes: false, actionCarry: true, askExpand: true, shareExternalGuard: true };
  const FIELDS = { keepAudioDays: '14', screenNotesEverySec: '30', consentText: 'This meeting is being transcribed by Debrief to write the minutes.', webhookUrl: '', voiceModelUrl: '' };
  const pages = { recordNudge: 'general', nudgeSkipOneOnOne: 'general', consentNotice: 'general', keepAudio: 'general', screenNotes: 'general', actionCarry: 'minutes', askExpand: 'minutes', shareExternalGuard: 'email', keepAudioDays: 'general', screenNotesEverySec: 'general', consentText: 'general', webhookUrl: 'minutes', voiceModelUrl: 'voices' };
  for (const [k, def] of Object.entries(SWITCHES)) {
    await tab(pages[k]);
    const r = await ev(`(() => { const f = document.getElementById('${k}'); const l = document.querySelector('label[for="${k}"]'); const d = (f.getAttribute('aria-describedby') || '').split(' ').map((i) => document.getElementById(i)?.textContent.trim()).filter(Boolean); return { exists: !!f, role: f.getAttribute('role'), name: l?.textContent.trim(), hint: d.length > 0, checked: f.checked }; })()`);
    check(`${k}: switch with a label and a hint, default ${def}`, r.exists && r.role === 'switch' && !!r.name && r.hint && r.checked === def, JSON.stringify(r));
  }
  for (const [k, def] of Object.entries(FIELDS)) {
    await tab(pages[k]);
    if (k === 'voiceModelUrl') await ev(`document.getElementById('modelDl').hidden = false`); // hidden in the full build
    const r = await ev(`(() => { const f = document.getElementById('${k}'); const l = document.querySelector('label[for="${k}"]'); return { exists: !!f, name: l?.textContent.trim(), value: f.value }; })()`);
    check(`${k}: field with a label, default "${def}"`, r.exists && !!r.name && r.value === def, JSON.stringify(r));
  }
  await tab('speech');
  const chunk = await ev(`[...document.querySelectorAll('#sttGeminiChunk option')].map((o) => o.value + ':' + o.textContent).join('|')`);
  check('sttGeminiChunk offers Short (about 40 seconds), the old choices keep their words', chunk === 'short:Short (about 40 seconds)|standard:About 2 minutes|long:About 4 minutes (fewer requests)', chunk);
  await tab('minutes');
  const eng = await ev(`(() => { const g = document.querySelector('[data-seg-for="minutesEngine"]'); return { name: g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')).textContent, sel: document.getElementById('minutesEngine').value, checked: [...g.querySelectorAll('button')].map((b) => b.dataset.v + ':' + b.getAttribute('aria-checked') + ':' + b.textContent), roles: [...g.querySelectorAll('button')].every((b) => b.getAttribute('role') === 'radio') }; })()`);
  check('minutesEngine: segmented control, Structured (recommended) selected by default', eng.sel === 'structured' && eng.checked.join('|') === 'structured:true:Structured (recommended)|classic:false:Classic' && eng.roles && !!eng.name, JSON.stringify(eng));
  const tmpl = await ev(`document.querySelector('#minutesFormatSeg button[data-v="template"]')?.textContent`);
  check('minutes format button uses data-v="template"', tmpl === 'Organisation template', tmpl);
  const dead = await ev(`/second Gemini key|geminiKey2/i.test(document.documentElement.outerHTML)`);
  check('no markup refers to a second Gemini key', dead === false);

  // ---- 2. change, save, persisted under the right key and type ----
  await tab('general');
  await tick('#recordNudge', false);
  check('nudgeSkipOneOnOne is disabled and dimmed while recordNudge is off', (await get('#nudgeSkipOneOnOne', 'disabled')) === true && (await ev(`document.getElementById('nudgeSkipOneOnOne').closest('.trow').classList.contains('is-off')`)));
  await tick('#recordNudge', true);
  check('nudgeSkipOneOnOne is enabled again when recordNudge is on', (await get('#nudgeSkipOneOnOne', 'disabled')) === false);
  check('keepAudioDays, screenNotesEverySec and consentText start disabled (their switches are off)', (await get('#keepAudioDays', 'disabled')) && (await get('#screenNotesEverySec', 'disabled')) && (await get('#consentText', 'disabled')) && (await get('#consentReset', 'disabled')));
  await tick('#keepAudio', true);
  await tick('#screenNotes', true);
  await tick('#consentNotice', true);
  check('dependents enable with their switch', !(await get('#keepAudioDays', 'disabled')) && !(await get('#screenNotesEverySec', 'disabled')) && !(await get('#consentText', 'disabled')) && !(await get('#consentReset', 'disabled')));

  await setVal('#keepAudioDays', '999');
  check('keepAudioDays clamps to 365', (await get('#keepAudioDays')) === '365');
  await setVal('#keepAudioDays', '-4');
  check('keepAudioDays clamps to 0', (await get('#keepAudioDays')) === '0');
  await setVal('#keepAudioDays', '');
  check('an empty keepAudioDays goes back to 14', (await get('#keepAudioDays')) === '14');
  await setVal('#screenNotesEverySec', '1');
  check('screenNotesEverySec clamps up to 10', (await get('#screenNotesEverySec')) === '10');
  await setVal('#screenNotesEverySec', '99999');
  check('screenNotesEverySec clamps down to 300', (await get('#screenNotesEverySec')) === '300');
  await setVal('#keepAudioDays', '30');
  await setVal('#screenNotesEverySec', '45');
  await setVal('#consentText', 'We are recording this call for the minutes.');
  await setVal('#sttGeminiChunk', 'short');
  await tick('#recordNudge', false);
  await tab('minutes');
  await click('[data-seg-for="minutesEngine"] button[data-v="classic"]');
  await tick('#actionCarry', false);
  await tick('#askExpand', false);
  await tab('email');
  await tick('#shareExternalGuard', false);
  await save();
  const s1 = await saved();
  check('saved: numbers are numbers under the right keys', s1.keepAudioDays === 30 && s1.screenNotesEverySec === 45, JSON.stringify([s1.keepAudioDays, s1.screenNotesEverySec]));
  check('saved: switches are booleans under the right keys', s1.keepAudio === true && s1.screenNotes === true && s1.consentNotice === true && s1.recordNudge === false && s1.actionCarry === false && s1.askExpand === false && s1.shareExternalGuard === false && s1.nudgeSkipOneOnOne === true, JSON.stringify([s1.keepAudio, s1.screenNotes, s1.consentNotice, s1.recordNudge, s1.actionCarry, s1.askExpand, s1.shareExternalGuard, s1.nudgeSkipOneOnOne]));
  check('saved: text, chunk and engine', s1.consentText === 'We are recording this call for the minutes.' && s1.sttGeminiChunk === 'short' && s1.minutesEngine === 'classic', JSON.stringify([s1.consentText, s1.sttGeminiChunk, s1.minutesEngine]));
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await tab('general');
  const back = await ev(`({ days: document.getElementById('keepAudioDays').value, off: document.getElementById('recordNudge').checked, skipDis: document.getElementById('nudgeSkipOneOnOne').disabled, daysDis: document.getElementById('keepAudioDays').disabled, chunk: document.getElementById('sttGeminiChunk').value, engine: document.getElementById('minutesEngine').value })`);
  check('after a reload the new values are shown and dependents follow', back.days === '30' && back.off === false && back.skipDis === true && back.daysDis === false && back.chunk === 'short' && back.engine === 'classic', JSON.stringify(back));
  await click('#consentReset');
  check('Reset to default puts the notice text back', (await get('#consentText')) === FIELDS.consentText);

  // ---- 3. webhook ----
  await tab('minutes');
  await setVal('#webhookUrl', 'ftp://example.com/x');
  await save();
  const bad = await ev(`({ err: document.getElementById('webhookErr').textContent, shown: !document.getElementById('webhookErr').hidden, inv: document.getElementById('webhookUrl').getAttribute('aria-invalid'), bar: document.getElementById('savebar').className })`);
  const s2 = await saved();
  check('an invalid webhook address shows the inline error and is not saved', bad.shown && bad.err.length > 10 && bad.inv === 'true' && !s2.webhookUrl && /bad/.test(bad.bar), JSON.stringify(bad));
  await setVal('#webhookUrl', 'https://user:pw@example.com/x');
  await save();
  check('an address with a password is refused too', !(await saved()).webhookUrl && (await ev(`!document.getElementById('webhookErr').hidden`)));
  await setVal('#webhookUrl', `http://127.0.0.1:${port}/hook`);
  await save();
  const ok = await ev(`({ shown: !document.getElementById('webhookErr').hidden, msg: document.getElementById('webhookMsg').textContent })`);
  check('a valid address is saved, no error and no permission warning (the host is allowed)', (await saved()).webhookUrl === `http://127.0.0.1:${port}/hook` && !ok.shown && !/permission/.test(ok.msg), JSON.stringify(ok));
  await click('#webhookTest');
  await sleep(800);
  const t1 = await ev(`document.getElementById('webhookMsg').textContent`);
  check('Send a test posts { app, version, event: "test" } and shows the HTTP result', hits.length === 1 && JSON.parse(hits[0].body).event === 'test' && JSON.parse(hits[0].body).app === 'debrief' && /HTTP 200/.test(t1), `${t1} ${JSON.stringify(hits)}`);
  await setVal('#webhookUrl', `http://127.0.0.1:${port}/hook-fail`);
  await click('#webhookTest');
  await sleep(800);
  check('a refused test shows the HTTP status', /HTTP 404/.test(await ev(`document.getElementById('webhookMsg').textContent`)));
  await setVal('#webhookUrl', '');
  await click('#webhookTest');
  check('Send a test with an empty address asks for one', /first/.test(await ev(`document.getElementById('webhookErr').textContent`)));
  await setVal('#webhookUrl', '');
  await save();
  check('an empty webhook address is saved as empty', (await saved()).webhookUrl === '');

  // ---- 4. the share guard note ----
  await tab('email');
  await setVal('#emailTo', 'someone@gmail.com');
  await tick('#shareExternalGuard', true);
  check('guard note shows when no domains are set and the address is free-mail', (await ev(`!document.getElementById('guardNote').hidden`)) === true);
  await tab('minutes');
  await setVal('#myOrgDomains', 'company.com');
  await tab('email');
  check('guard note hides once domains are filled in', (await ev(`document.getElementById('guardNote').hidden`)) === true);
  await setVal('#myOrgDomains', '');
  await setVal('#emailTo', 'me@company.com');
  check('guard note hides when the address is a company one', (await ev(`document.getElementById('guardNote').hidden`)) === true);
  await setVal('#emailTo', '');
  await tick('#shareExternalGuard', false);
  check('guard note hides when the guard is off', (await ev(`document.getElementById('guardNote').hidden`)) === true);

  // ---- 5. back up and restore ----
  await ev(`(async () => { const r = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...r.settings, geminiKey: 'AIzaSECRETKEY123456789', emailSecret: 'sekret' } }); })()`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await tab('general');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const waitFile = async (n) => {
    for (let i = 0; i < 40; i++) {
      const f = readdirSync(downloads).filter((x) => x.endsWith('.json'));
      if (f.length >= n) return f.sort();
      await sleep(150);
    }
    return readdirSync(downloads);
  };
  await click('#backupDownload');
  const f1 = await waitFile(1);
  const stamp = new Date();
  check('the backup file is named debrief-backup-YYYY-MM-DD.json', /^debrief-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f1[0] || ''), f1.join());
  const b1 = JSON.parse(readFileSync(path.join(downloads, f1[0]), 'utf8'));
  check('the default backup has no API keys and no email secret', b1.app === 'debrief' && !('geminiKey' in b1.settings) && !('emailSecret' in b1.settings) && !JSON.stringify(b1).includes('AIzaSECRETKEY'), Object.keys(b1.settings).slice(0, 5).join());
  await tick('#backupKeys', true);
  await click('#backupDownload');
  await sleep(800);
  const f2 = readdirSync(downloads).filter((x) => x.endsWith('.json'));
  const withKeys = f2.map((x) => JSON.parse(readFileSync(path.join(downloads, x), 'utf8'))).find((b) => 'geminiKey' in b.settings);
  check('ticking "Include my API keys" puts them in the file', !!withKeys && withKeys.settings.geminiKey === 'AIzaSECRETKEY123456789' && /Keep it private/.test(await get('#backupDownloadMsg', 'textContent')));
  await tick('#backupKeys', false);

  const mid = 'm1700000000123';
  const file = path.join(work, 'restore.json');
  writeFileSync(file, JSON.stringify({ app: 'debrief', version: 1, schema: 3, settings: { myName: 'From Backup' }, meetings: [{ id: mid, title: 'Restored <b>meeting</b>', startedAt: 1700000000123, segments: [] }], voices: [] }));
  const { root } = await send('DOM.getDocument', {}, pg.sessionId);
  const fileNode = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#backupFile' }, pg.sessionId);
  await send('DOM.setFileInputFiles', { files: [file], nodeId: fileNode.nodeId }, pg.sessionId);
  await sleep(600);
  const dlg = await ev(`({ text: document.querySelector('dialog.dbmodal')?.textContent || '', buttons: [...document.querySelectorAll('dialog.dbmodal button')].map((b) => b.textContent) })`);
  check('restore asks first and says what the file holds', /1 meeting, settings, 0 voices/.test(dlg.text) && dlg.buttons.join('|') === 'Cancel|Replace everything|Add to what is here', JSON.stringify(dlg));
  await ev(`document.querySelector('dialog.dbmodal button[data-value="merge"]').click()`);
  await sleep(1200);
  const after = await ev(`chrome.storage.local.get(['meetingIds', 'settings']).then((r) => ({ ids: r.meetingIds, name: r.settings.myName, key: r.settings.geminiKey, msg: document.getElementById('backupRestoreMsg').textContent }))`);
  check('restore (add) adds the meeting, keeps the key here, shows the counts', after.ids?.includes(mid) && after.name === 'From Backup' && after.key === 'AIzaSECRETKEY123456789' && /1 meeting added/.test(after.msg), JSON.stringify(after));
  check('restore reloads the page fields', (await get('#myName')) === 'From Backup');
  const inj = await ev(`document.body.innerHTML.includes('<b>meeting</b>')`);
  check('file content is never rendered as HTML', inj === false);
  // not a backup
  writeFileSync(file, JSON.stringify({ hello: 'world' }));
  const n2 = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#backupFile' }, pg.sessionId);
  await send('DOM.setFileInputFiles', { files: [file], nodeId: n2.nodeId }, pg.sessionId);
  await sleep(500);
  check('a file that is not a backup is refused with no dialog', /not a Debrief backup/.test(await get('#backupRestoreMsg', 'textContent')) && !(await ev(`!!document.querySelector('dialog.dbmodal')`)));
  // replace needs a second confirmation
  writeFileSync(file, JSON.stringify({ app: 'debrief', version: 1, schema: 3, meetings: [], voices: [] }));
  await send('DOM.setFileInputFiles', { files: [file], nodeId: n2.nodeId }, pg.sessionId);
  await sleep(500);
  await ev(`document.querySelector('dialog.dbmodal button[data-value="replace"]').click()`);
  await sleep(300);
  const second = await ev(`document.querySelector('dialog.dbmodal')?.textContent || ''`);
  check('Replace everything asks a second time and says what is deleted', /deletes the 1 meeting here/.test(second), second);
  await ev(`document.querySelector('dialog.dbmodal button[data-value="no"]').click()`);
  await sleep(300);
  check('cancelling the second question restores nothing', (await ev(`chrome.storage.local.get('meetingIds').then((r) => r.meetingIds)`)).includes(mid));

  // a file that wants to change where data goes: listed in words, each unticked; nothing changes unless ticked (review H1)
  await ev(`(async () => { const r = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...r.settings, sttProvider: 'openai', sttKey: 'gsk_MINE', sttBase: 'https://api.groq.com/openai/v1' } }); })()`);
  const evilBase = `http://127.0.0.1:${port}/v1`;
  writeFileSync(file, JSON.stringify({ app: 'debrief', version: 1, schema: 3, meetings: [], voices: [], settings: { sttBase: evilBase, consentNotice: true, consentText: 'Join https://evil.example now', shareMode: 'auto', webhookUrl: 'https://evil.example/hook-TOKEN', keepAudioDays: 5 } }));
  const routeDialog = async () => {
    await send('DOM.setFileInputFiles', { files: [file], nodeId: n2.nodeId }, pg.sessionId);
    await sleep(600);
    return ev(`(() => { const d = document.querySelector('dialog.dbmodal'); return d && { text: d.textContent, boxes: [...d.querySelectorAll('input[type=checkbox]')].map((c) => ({ key: c.dataset.key, checked: c.checked, name: c.closest('label')?.textContent })), html: d.innerHTML.includes('<b>Join') }; })()`);
  };
  const pre = await saved();
  let rd = await routeDialog();
  check(
    'restore lists the changes to where data goes, in words, each unticked, with the warning',
    !!rd && /This file also wants to change where your data goes:/.test(rd.text) && /Only tick these if you made this backup yourself\./.test(rd.text) && ['sttBase', 'webhookUrl', 'shareMode', 'consentText'].every((k) => rd.boxes.some((b) => b.key === k)) && rd.boxes.every((b) => !b.checked) &&
      rd.boxes.some((b) => b.name === `Speech-to-text server address: https://api.groq.com/openai/v1 → ${evilBase}`) && rd.boxes.some((b) => /^Notice posted in the meeting chat: .* → Join https:\/\/evil\.example now$/.test(b.name)) && !rd.text.includes('TOKEN'),
    JSON.stringify(rd)
  );
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const [scheme, w] of [['light', 1280], ['dark', 1280], ['light', 420], ['dark', 420]]) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, pg.sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
      await sleep(350);
      writeFileSync(path.join(SHOTS, `restore-${scheme}-${w}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, pg.sessionId)).data, 'base64'));
    }
    await send('Emulation.setEmulatedMedia', { features: [] }, pg.sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
  }
  await ev(`document.querySelector('dialog.dbmodal button[data-value="merge"]').click()`);
  await sleep(1200);
  let rs = await saved();
  const keys = ['sttBase', 'sttKey', 'consentNotice', 'consentText', 'shareMode', 'webhookUrl', 'keepAudioDays'];
  check('nothing ticked: the servers, sharing, webhook and chat notice stay as they were; the key and settings set here stay', keys.every((k) => JSON.stringify(rs[k]) === JSON.stringify(pre[k])) && rs.sttKey === 'gsk_MINE', JSON.stringify(keys.map((k) => [k, pre[k], rs[k]])));
  rd = await routeDialog();
  await ev(`(() => { document.querySelector('dialog.dbmodal input[data-key="sttBase"]').click(); document.querySelector('dialog.dbmodal button[data-value="merge"]').click(); })()`);
  await sleep(1200);
  rs = await saved();
  const rmsg = await get('#backupRestoreMsg', 'textContent');
  const rwarn = await ev(`document.getElementById('backupWarnings').textContent`);
  check('ticking one change takes only that one, and the key here is not sent to the new server', rs.sttBase === evilBase && rs.sttKey === '' && rs.consentText === pre.consentText && rs.shareMode === pre.shareMode && !rs.webhookUrl && /1 setting about where data goes changed/.test(rmsg) && /speech-to-text key was removed/.test(rwarn), JSON.stringify({ sttBase: rs.sttBase, key: rs.sttKey, rmsg, rwarn }));

  // ---- 6. model names (Gemini's list answered by the test, nothing leaves this computer) ----
  await ev(`chrome.storage.local.set({ settings: { llmProvider: 'gemini', sttProvider: 'gemini', geminiKey: 'AIzaTESTKEY0123456789012345', geminiModel: 'gemini-3.8-flash', sttGeminiModel: 'gemini-3.5-transcribe' }, modelLists: {} })`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://generativelanguage.googleapis.com/*' }] }, pg.sessionId);
  listeners.push((m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== pg.sessionId) return;
    const body = JSON.stringify({ models: ['gemini-3.5-transcribe', 'gemini-3.9-flash', 'gemini-3.5-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) });
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(body).toString('base64') }, pg.sessionId).catch(() => {});
  });
  await tab('start');
  await click('#checkModels');
  await sleep(1500);
  const mrows = await ev(`[...document.querySelectorAll('#modelOut li')].map((li) => ({ text: li.textContent, use: [...li.querySelectorAll('button')].map((b) => b.textContent) }))`);
  const first = mrows.find((r) => /Minutes model "gemini-3.8-flash"/.test(r.text));
  check('Check model names reports the missing model with the closest one', !!first && /Closest available: "gemini-3.9-flash"/.test(first.text) && first.use.join() === 'Use gemini-3.9-flash', JSON.stringify(mrows));
  check('the speech model that exists is not listed', !mrows.some((r) => /gemini-3.5-transcribe/.test(r.text)));
  await ev(`[...document.querySelectorAll('#modelOut button')].find((b) => /Use gemini-3.9-flash/.test(b.textContent)).click()`);
  const filled = await ev(`({ v: document.getElementById('geminiModel').value, bar: document.getElementById('savebar').className })`);
  check('"Use <id>" fills the field and leaves saving to the Save bar', filled.v === 'gemini-3.9-flash' && /dirty/.test(filled.bar) && (await saved()).geminiModel === 'gemini-3.8-flash', JSON.stringify(filled));
  await click('#checkup');
  await sleep(2500);
  const line = await ev(`[...document.querySelectorAll('#checkupOut li')].map((li) => li.textContent).find((t) => /Model names/.test(t)) || ''`);
  check('Check my setup carries a Model names line, from the lists fetched before', /Model names/.test(line) && /gemini-3.8-flash/.test(line), line);

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const w of [1280, 420]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
      await sleep(300);
      writeFileSync(path.join(SHOTS, `models-dirty-${w}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, pg.sessionId)).data, 'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
  }
  // ---- 7. voices: the speaker model line ----
  await tab('voices');
  const vm = await ev(`({ state: document.getElementById('modelState').textContent, dl: document.getElementById('modelDl').hidden })`);
  check('Voices: the full build shows one quiet line and no download controls', vm.state === 'Speaker model: included with this install' && vm.dl === true, JSON.stringify(vm));

  // ---- 8. kept recordings ----
  await tab('general');
  const kept = await ev(`document.getElementById('keptNow').textContent`);
  check('Kept now shows a count and a size', /^Kept now: 0 meetings, 0 MB$/.test(kept) && (await get('#keptDelete', 'disabled')), kept);

  // ---- 9. no page scrolls sideways, none logs an error ----
  for (const w of [1280, 900, 420]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
    const bad = [];
    for (const name of PAGES) {
      await tab(name);
      await sleep(120);
      const o = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`);
      if (o.sw > o.iw) {
        const who = await ev(`[...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getBoundingClientRect().width > 0 && !/^(I|B)$/.test(e.tagName) && !e.closest('.fx-bg')).slice(0, 4).map((e) => e.tagName + '#' + e.id + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).join(' ; ')`);
        const dims = await ev(`['body', '.shell', '.content', '.savebar', '#msg', '.page.active'].map((q) => q + ':' + Math.round(document.querySelector(q).getBoundingClientRect().width)).join(' ')`);
        const wide = await ev(`[...document.querySelectorAll('.page.active *')].filter((e) => e.getBoundingClientRect().width > 430).slice(0, 8).map((e) => e.tagName + '#' + e.id + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().width)).join(' ; ')`);
        const kids = await ev(`[...document.querySelector('.content').children].map((e) => e.tagName + '#' + e.id + '.' + e.className.slice(0, 20) + ' ' + Math.round(e.getBoundingClientRect().width) + ' disp=' + getComputedStyle(e).display).join(' ; ') + ' || ' + getComputedStyle(document.querySelector('.content')).cssText.length + ' mw=' + getComputedStyle(document.querySelector('.content')).minWidth + ' w=' + getComputedStyle(document.querySelector('.content')).width + ' ' + document.documentElement.className`);
        bad.push(`${name} ${o.sw}>${o.iw} (${who}) ${dims} KIDS ${kids}`);
      }
    }
    check(`no horizontal scroll at ${w} px on ${PAGES.join(', ')}`, !bad.length, bad.join());
  }
  check('no console errors or exceptions on any settings page', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ---- screenshots ----
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await ev(`chrome.storage.local.set({ settings: { llmProvider: 'gemini', sttProvider: 'gemini', geminiKey: 'AIzaTESTKEY0123456789012345', myName: 'Priya' } })`);
    await send('Page.reload', {}, pg.sessionId);
    await sleep(1500);
    for (const [scheme, w] of [['light', 1280], ['dark', 1280], ['light', 420], ['dark', 420]]) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, pg.sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
      for (const name of PAGES) {
        await tab(name);
        await sleep(350);
        const h = await ev(`Math.ceil(document.documentElement.scrollHeight)`);
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: Math.min(h, 8000), deviceScaleFactor: 1, mobile: false }, pg.sessionId);
        await sleep(200);
        const r = await send('Page.captureScreenshot', { format: 'png' }, pg.sessionId);
        writeFileSync(path.join(SHOTS, `${name}-${scheme}-${w}.png`), Buffer.from(r.data, 'base64'));
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
      }
    }
  }
} catch (e) {
  console.log('FAIL', e.stack || e);
  failed = true;
} finally {
  try {
    await send('Browser.close');
  } catch {}
  proc.kill();
  server.close();
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}
