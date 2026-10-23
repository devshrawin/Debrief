// Redesign smoke test: loads the unpacked extension in Chromium, seeds a
// sample meeting, opens every page in light and dark at desktop and narrow
// widths, and fails on any console error, page error, failed request to a
// non-extension URL, or serious/critical axe violation. Screenshots go to
// test/out/ for review.
//
//   node test/smoke.mjs [--shots]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const outDir = join(root, 'test', 'out');
mkdirSync(outDir, { recursive: true });
const axeSrc = readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
const shots = process.argv.includes('--shots');

const now = Date.now();
const SAMPLE = {
  id: 'smoke1', title: 'Weekly sync: Kochi depot rollout', startedAt: now - 45 * 60e3, endedAt: now - 3 * 60e3,
  segments: [
    { t: 12, src: 'tab', text: 'Good morning everyone, let us start with the budget.' },
    { t: 40, src: 'me', text: 'I have the revised sheet; cabling is the main change.' },
    { t: 95, src: 'tab', text: 'मैं सोमवार तक वेंडर से पक्का कर दूँगा।' },
    { t: 130, src: 'tab', text: 'ജീവനക്കാർക്ക് മലയാളത്തിൽ പരിശീലനം നൽകണം.' },
  ],
  errors: [], voiceSegs: [], captions: [], attendees: ['Priya Nair', 'Ravi Menon'], notes: '',
  model: 'Gemini 2.5 Flash', stt: 'gemini-2.5-flash', emailedAt: now - 60e3, emailedTo: 'you@example.com',
  mom: '# Weekly sync: Kochi depot rollout\n\n## Summary\nThe team agreed to start the pilot in three depots from 1 November.\n\n## Decisions\n- Pilot starts 1 November.\n- Fare tables freeze on 25 October.\n\n## Action items\n| Action | Owner | Due |\n|---|---|---|\n| Send the revised budget | Priya Nair | Fri 16 Oct |\n| Confirm validator numbers | Ravi Menon | Mon 19 Oct |\n\n## Attendance\n| Person | In the meeting |\n|---|---|\n| Priya Nair | Yes |\n| Ravi Menon | Yes |\n',
};

// [name, path, width, height, setup?] — setup runs in the page, then the page reloads.
const PAGES = [
  ['popup', 'popup.html', 380, 640],
  ['popup-call', 'popup.html', 380, 640, async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, geminiKey: 'test-key-not-real' } });
    const tab = await chrome.tabs.getCurrent();
    await chrome.action.setBadgeText({ tabId: tab.id, text: '\u25CF' });
  }],
  ['popup-recording', 'popup.html', 380, 760, async () => {
    await chrome.storage.session.set({
      rec: { recording: true, startedAt: Date.now() - 754e3, meetingId: 'smoke1', mic: true, micOn: true, micWanted: true, meetMuted: false,
        alert: { kind: 'key', title: 'Gemini limit reached', detail: 'Audio is kept and transcribed when the limit resets, or now with a backup key.' } },
      levels: { tab: 0.05, mic: 0.006, at: Date.now() + 60e3 },
    });
  }],
  ['options', 'options.html', 1280, 900],
  ['options-narrow', 'options.html', 480, 900],
  ['welcome', 'welcome.html', 1280, 900],
  ['mom', 'mom.html?id=smoke1', 1280, 900],
  ['mom-narrow', 'mom.html?id=smoke1', 400, 900],
  ['ask', 'ask.html', 1280, 900],
];

const failures = [];
const report = {};
for (const scheme of ['light', 'dark']) {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', colorScheme: scheme,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const id = sw.url().split('/')[2];
  const seed = await ctx.newPage();
  await seed.goto(`chrome-extension://${id}/ask.html`);
  await seed.evaluate((m) => chrome.storage.local.set({ [`meeting:${m.id}`]: m, meetingIds: [m.id] }), SAMPLE);
  await seed.close();

  for (const [name, path, w, h, setup] of PAGES) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('requestfailed', (r) => { if (!r.url().startsWith('chrome-extension://')) errs.push('request failed: ' + r.url()); });
    p.on('request', (r) => { const u = r.url(); if (!/^(chrome-extension|data|blob):/.test(u)) errs.push('unexpected network request: ' + u); });
    if (setup) {
      await p.goto(`chrome-extension://${id}/${path}`, { waitUntil: 'load' });
      await p.evaluate(`(${setup.toString()})()`);
    }
    const t0 = Date.now();
    await p.goto(`chrome-extension://${id}/${path}`, { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    if (name.startsWith('popup-call')) {
      await p.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.action.setBadgeText({ tabId: tab.id, text: '\u25CF' }); window.dispatchEvent(new Event('focus')); });
    }
    await p.waitForTimeout(900);
    const fcp = await p.evaluate(() => Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0));
    await p.evaluate(axeSrc);
    const axe = await p.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations'] });
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join('')) }));
    });
    if (setup) await p.evaluate(async () => { await chrome.storage.session.remove(['rec', 'levels']); const tab = await chrome.tabs.getCurrent(); await chrome.action.setBadgeText({ tabId: tab.id, text: '' }); });
    if (shots) await p.screenshot({ path: join(outDir, `${name}-${scheme}.png`), fullPage: true });
    report[`${name}-${scheme}`] = { loadMs, fcp, errors: errs, axe };
    if (errs.length) failures.push(`${name}-${scheme}: ${errs.join(' | ')}`);
    if (axe.length) failures.push(`${name}-${scheme}: axe ${axe.map((a) => `${a.id}(${a.n})`).join(', ')}`);
    await p.close();
  }
  await ctx.close();
}
// Calm-mode check: with reduced motion, effects must stay off.
{
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const id = sw.url().split('/')[2];
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.evaluate(() => chrome.storage.session.set({ rec: { recording: true, startedAt: Date.now() - 5e3, meetingId: 'x', mic: false } }));
  await p.reload(); await p.waitForTimeout(900);
  const calm = await p.evaluate(() => ({ beam: document.getElementById('heroCard').hasAttribute('data-active'), anim: getComputedStyle(document.getElementById('dot')).animationDuration }));
  report['reduced-motion'] = calm;
  // RTL and 200% zoom (half-width viewport): no horizontal scrolling.
  for (const [path, w, rtl] of [['options.html', 1280, true], ['popup.html', 380, true], ['mom.html?id=smoke1', 640, false], ['options.html', 640, false]]) {
    const q = await ctx.newPage(); await q.setViewportSize({ width: w, height: 800 });
    await q.goto(`chrome-extension://${id}/${path}`); await q.waitForTimeout(400);
    if (rtl) await q.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const over = await q.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (over) failures.push(`${path} @${w}${rtl ? ' rtl' : ''}: horizontal overflow`);
    await q.close();
  }
  if (calm.beam) failures.push('reduced-motion: recording beam is active');
  await ctx.close();
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
for (const [k, v] of Object.entries(report)) if (v.axe) console.log(`${k.padEnd(22)} load ${String(v.loadMs).padStart(4)} ms  fcp ${String(v.fcp).padStart(4)} ms  errors ${v.errors.length}  axe ${v.axe.length ? v.axe.map((a) => `${a.id}(${a.n})`).join(',') : 0}`);
console.log('reduced-motion: beam active =', report['reduced-motion'].beam);
if (failures.length) { console.error('\nFAIL\n' + failures.join('\n')); process.exit(1); }
console.log('\nPASS');
