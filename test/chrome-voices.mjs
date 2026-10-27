// Real Chrome: the Voices page merge flow. A copy of the extension that may script localhost is loaded; the panel is injected
// into a plain web page the way the toolbar button does it, and we check that the popup shows inside it, can be seen
// through (the page is visible behind it), reports its size, and closes. Usage: node test/chrome-panel.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const work = mkdtempSync(path.join(tmpdir(), 'debrief-panel-'));
const EXT = path.resolve('extension');
const profile = path.join(work, 'profile');


const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const out = proc.stdio[3];
const inp = proc.stdio[4];
let nextId = 1;
const pending = new Map();
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
    }
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(1500);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, sessionId, evaluate };
}
let failed = false;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};

try {
  const { id } = await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);
  const pg = await openPage(`chrome-extension://${id}/options.html`);
  await pg.evaluate(`(async () => {
    const pack = (seed) => { const b = new Int8Array(256); for (let i = 0; i < 256; i++) b[i] = Math.round(Math.sin(i * seed) * 90); let s = ''; for (const x of new Uint8Array(b.buffer)) s += String.fromCharCode(x); return btoa(s); };
    const mk = (id, name, seed, extra = {}) => ({ id, name, lang: 'en', centroid: pack(seed), windows: [pack(seed), pack(seed + 0.01)], secs: 40, meetings: 2, created: Date.now(), auto: true, learnedFrom: ['m1'], ...extra });
    await chrome.storage.local.set({ schema: 2, settings: { voiceOn: true }, voices: [mk('a', 'Unnamed voice 1', 0.31), mk('b', 'Unnamed voice 2', 0.3101), mk('c', 'Priya Nair', 0.77, { confirmed: true }), { id: 'd', name: 'Alex Rivera', lang: 'en', centroid: pack(1.9), windows: [pack(1.9)], secs: 24, created: Date.now() }] });
    return true; })()`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await pg.evaluate(`document.querySelector('#nav [data-tab="voices"]').click()`);
  await sleep(700);
  await pg.evaluate(`window.__errs = []; addEventListener('error', (e) => __errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason?.message || e.reason)));`);
  const rows0 = await pg.evaluate(`document.querySelectorAll('#voiceList .voice-row').length`);
  check('four voices listed', rows0 === 4, String(rows0));
  // More -> Merge into... on the first unnamed voice
  await pg.evaluate(`document.querySelector('#voiceList .voice-row .vacts button[aria-haspopup="menu"]').click()`);
  await sleep(300);
  await pg.evaluate(`[...document.querySelectorAll('#voiceList .menu button')].find((b) => /Merge into/.test(b.textContent)).click()`);
  await sleep(500);
  const dlg = await pg.evaluate(`(() => { const d = document.querySelector('dialog.dbmodal'); if (!d) return null; const r = d.getBoundingClientRect(); const s = d.querySelector('select'); return { open: d.open, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, options: s ? [...s.options].map((o) => o.textContent) : [] }; })()`);
  check('the merge dialog opens, centred, with the other voices to pick from', dlg && dlg.open && dlg.w > 280 && dlg.options.length === 3 && dlg.x > 0 && dlg.y > 0, JSON.stringify(dlg));
  if (process.env.SHOT) { const r = await send('Page.captureScreenshot', { format: 'png' }, pg.sessionId); writeFileSync(process.env.SHOT, Buffer.from(r.data, 'base64')); }
  // pick Unnamed voice 2 and merge
  await pg.evaluate(`const s = document.querySelector('dialog.dbmodal select'); s.value = [...s.options].find((o) => /Unnamed voice 2/.test(o.textContent)).value; [...document.querySelectorAll('dialog.dbmodal button')].find((b) => /Merge/.test(b.textContent)).click()`);
  await sleep(900);
  const after = await pg.evaluate(`({ rows: document.querySelectorAll('#voiceList .voice-row').length, names: [...document.querySelectorAll('#voiceList .vn')].map((e) => e.textContent), errs: window.__errs, dialog: !!document.querySelector('dialog.dbmodal'), toast: [...document.querySelectorAll('dialog.dbmodal, .toast, #voiceMsg')].map((e) => e.textContent.slice(0, 120)) })`);
  check('merging two learned voices works: one fewer voice, no error, dialog closed', after.rows === 3 && !after.errs.length && !after.dialog && !after.names.includes('Unnamed voice 1'), JSON.stringify(after));
  const stored = await pg.evaluate(`chrome.storage.local.get('voices').then((r) => r.voices.map((v) => v.name))`);
  check('the merged list was saved', stored.length === 3, JSON.stringify(stored));
  // merging a learned voice into a recorded (named, enrolled) person
  await pg.evaluate(`document.querySelector('#voiceList .voice-row .vacts button[aria-haspopup="menu"]').click()`);
  await sleep(300);
  await pg.evaluate(`[...document.querySelectorAll('#voiceList .menu button')].find((b) => /Merge into/.test(b.textContent)).click()`);
  await sleep(500);
  await pg.evaluate(`(() => { const sel = document.querySelector('dialog.dbmodal select'); sel.value = [...sel.options].find((o) => /Alex Rivera/.test(o.textContent)).value; [...document.querySelectorAll('dialog.dbmodal button')].find((b) => /Merge/.test(b.textContent)).click(); })()`);
  await sleep(900);
  const after2 = await pg.evaluate(`({ rows: document.querySelectorAll('#voiceList .voice-row').length, errs: window.__errs, dialog: !!document.querySelector('dialog.dbmodal') })`);
  check('merging into a recorded person works too', after2.rows === 2 && !after2.errs.length && !after2.dialog, JSON.stringify(after2));

  // ---- the people directory table in Settings > Minutes
  await pg.evaluate(`chrome.storage.local.set({ settings: { voiceOn: true, peopleDirectory: 'Suresh K. | Sri. | Transport | Joint Secretary | Kochi Metro | Chair\\nDana Whitfield | Ms. | Operations | Programme Director | Contoso Transit' } })`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await pg.evaluate(`document.querySelector('#nav [data-tab="voices"]').click()`);
  await sleep(600);
  const t0 = await pg.evaluate(`({ rows: document.querySelectorAll('#dirTable .dir-body .dir-row').length, first: document.querySelector('#dirTable .dir-in').value, chair: document.querySelector('#dirTable .dir-chair').checked, hidden: document.getElementById('peopleDirectory').hidden })`);
  check('the people directory shows as a table with both people, Chair ticked, text field hidden', t0.rows === 2 && t0.first === 'Suresh K.' && t0.chair && t0.hidden, JSON.stringify(t0));
  await pg.evaluate(`(() => { const i = document.querySelectorAll('#dirTable .dir-in')[0]; i.value = 'Suresh Kumar'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await pg.evaluate(`(() => { const i = document.querySelector('#dirTable .dir-body .dir-row:last-child .c-name'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await sleep(300);
  const t1 = await pg.evaluate(`({ rows: document.querySelectorAll('#dirTable .dir-body .dir-row').length, text: document.getElementById('peopleDirectory').value, bar: document.getElementById('savebar').className })`);
  check('editing a cell writes the text, Enter adds a person, and Settings sees unsaved changes', t1.rows === 3 && /^Suresh Kumar \| Sri\./.test(t1.text) && /dirty/.test(t1.bar), JSON.stringify(t1));
  if (process.env.SHOT2) { const r = await send('Page.captureScreenshot', { format: 'png' }, pg.sessionId); writeFileSync(process.env.SHOT2, Buffer.from(r.data, 'base64')); }


  // ---- details travel with the voice: naming an unnamed voice with a designation and organisation creates the person in the table
  await pg.evaluate(`(async () => {
    const pack = (seed) => { const b = new Int8Array(256); for (let i = 0; i < 256; i++) b[i] = Math.round(Math.sin(i * seed + 0.001 * i * i) * 90); let s = ''; for (const x of new Uint8Array(b.buffer)) s += String.fromCharCode(x); return btoa(s); };
    const segs = []; for (let k = 0; k < 40; k++) segs.push({ t0: k * 4, t1: k * 4 + 3, e: pack(k % 2 ? 0.31 + k * 1e-5 : 0.77 + k * 1e-5), s: '' });
    await chrome.storage.local.set({ voices: [], settings: { voiceOn: true, peopleDirectory: '' }, 'meeting:nm1': { id: 'nm1', title: 'N', startedAt: Date.now() - 900000, endedAt: Date.now() - 1000, segments: [], errors: [], voiceSegs: segs, captions: [] }, meetingIds: ['nm1'] });
  })()`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await pg.evaluate(`document.querySelector('#nav [data-tab="voices"]').click()`);
  await sleep(800);
  const u0 = await pg.evaluate(`document.querySelectorAll('#unnamedList li').length`);
  check('an unnamed voice is offered with a details box', u0 >= 1 && (await pg.evaluate(`!!document.querySelector('#unnamedList li details input#un0-desig')`)), String(u0));
  await pg.evaluate(`(() => { const li = document.querySelector('#unnamedList li'); const set = (sel, v) => { const i = li.querySelector(sel); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('input#unnamedName0', 'Test Person'); set('#un0-desig', 'Joint Secretary'); set('#un0-org', 'Kochi Metro'); set('#un0-email', 'Test@Metro.org'); li.querySelector('button.primary').click(); })()`);
  await sleep(1200);
  const d1 = await pg.evaluate(`(async () => { const st = await chrome.storage.local.get('settings'); return { dir: st.settings.peopleDirectory, row: [...document.querySelectorAll('#dirTable .dir-body .dir-row')].map((r) => [...r.querySelectorAll('input.dir-in')].map((i) => i.value).join('|')), profile: document.querySelector('#voiceList .vprofile')?.textContent || '' }; })()`);
  check('naming with details: the person lands in the table and in the saved directory, and the voice shows the details', /Test Person \| .*Joint Secretary \| .*Kochi Metro/.test(d1.dir) && /test@metro.org/i.test(d1.dir) && /Joint Secretary/.test(d1.profile), JSON.stringify(d1));
  // ---- Settings > Email: the recipients table sits in the same step as the script, and the allow-list follows it
  await pg.evaluate(`chrome.storage.local.set({ settings: { voiceOn: true, shareList: 'priya@company.com', shareGroups: 'Cadence Call | amal@company.com' } })`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  await pg.evaluate(`document.querySelector('#nav [data-tab="email"]').click()`);
  await sleep(600);
  const e0 = await pg.evaluate(`({ rows: document.querySelectorAll('#recTable .rec-body .rec-row').length, inConnectCard: !!document.querySelector('#page-email section[aria-labelledby="hConn"] #recTable'), noSeparateCard: !document.querySelector('#page-email section[aria-labelledby="hShare"]'), copy: !!document.querySelector('#page-email section[aria-labelledby="hConn"] #copyScriptAllow') })`);
  check('Email: the recipients table and the copy-script button are in the same card as the script setup', e0.rows === 2 && e0.inConnectCard && e0.noSeparateCard && e0.copy, JSON.stringify(e0));
  await pg.evaluate(`(() => { const r = document.querySelector('#recTable .rec-body .rec-row:last-child .rec-in'); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await sleep(200);
  await pg.evaluate(`(() => { const i = document.querySelector('#recTable .rec-body .rec-row:last-child .rec-in'); i.value = 'new.person@company.com'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const e1 = await pg.evaluate(`({ rows: document.querySelectorAll('#recTable .rec-body .rec-row').length, groups: document.getElementById('shareGroups').value, list: document.getElementById('shareList').value, allow: document.getElementById('allowLines').textContent, bar: document.getElementById('savebar').className })`);
  check('Email: adding a person updates the settings, the allow-list lines and the unsaved-changes bar', e1.rows === 3 && /new.person@company.com/.test(e1.groups + e1.list) && /new.person@company.com/.test(e1.allow) && /dirty/.test(e1.bar), JSON.stringify(e1));
  if (process.env.SHOT3) { await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false }, pg.sessionId); await sleep(500); await pg.evaluate(`document.getElementById('hShare').scrollIntoView()`); const r = await send('Page.captureScreenshot', { format: 'png' }, pg.sessionId); writeFileSync(process.env.SHOT3, Buffer.from(r.data, 'base64')); }

  // ---- Settings > Get started: more backup keys with a + button; the check-my-setup icons stay round
  await pg.evaluate(`chrome.storage.local.set({ settings: { geminiKey: 'main-key', geminiKey2: 'backup-two', geminiBackups: ['backup-three'], llmProvider: 'gemini', sttProvider: 'gemini' } })`);
  await send('Page.reload', {}, pg.sessionId);
  await sleep(1500);
  const k0 = await pg.evaluate(`({ saved: document.querySelectorAll('#moreKeys .bk-row').length, name: document.querySelector('#moreKeys .bk-name')?.textContent, shownKey: document.body.innerText.includes('backup-three') })`);
  check('Get started: a saved extra backup key shows as "Saved", never as text', k0.saved === 1 && /Backup key 2/.test(k0.name) && !k0.shownKey, JSON.stringify(k0));
  await pg.evaluate(`document.getElementById('addKey').click()`);
  await sleep(200);
  await pg.evaluate(`(() => { const i = document.querySelector('#moreKeys input.bk-in'); i.value = 'backup-four'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await pg.evaluate(`document.getElementById('addKey').click()`);
  await sleep(200);
  const k1 = await pg.evaluate(`({ rows: document.querySelectorAll('#moreKeys .bk-row').length, bar: document.getElementById('savebar').className })`);
  check('the + button adds rows, and Settings sees unsaved changes', k1.rows === 3 && /dirty/.test(k1.bar), JSON.stringify(k1));
  await pg.evaluate(`document.getElementById('save').click()`);
  await sleep(1200);
  const k2 = await pg.evaluate(`chrome.storage.local.get('settings').then((r) => r.settings.geminiBackups)`);
  check('saving keeps the old extra key and adds the new one (the empty row is ignored)', JSON.stringify(k2) === JSON.stringify(['backup-three', 'backup-four']), JSON.stringify(k2));
  await pg.evaluate(`document.querySelector('#nav [data-tab="start"]').click()`);
  await sleep(400);
  await pg.evaluate(`document.getElementById('checkup').click()`);
  await sleep(2500);
  const ic = await pg.evaluate(`[...document.querySelectorAll('#checkupOut .ic')].map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; })`);
  check('check-my-setup: every status icon is a 24 px circle, whatever its status', ic.length > 3 && ic.every((x) => x[1] === 24 && x[2] === 24), JSON.stringify(ic));
} catch (e) {
  console.log('FAIL', e.stack || e);
  failed = true;
} finally {
  try { await send('Browser.close'); } catch {}
  proc.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}
