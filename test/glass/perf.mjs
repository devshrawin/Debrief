// Median first-contentful-paint of each page over N warm loads.
//   node test/perf.mjs [N]
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ext = process.env.EXT || join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const N = Number(process.argv[2] || 9);
const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
for (const [name, path, w] of [['popup', 'popup.html', 380], ['options', 'options.html', 1280], ['mom', 'mom.html?id=x', 1280], ['ask', 'ask.html', 1280]]) {
  const fcp = [], lcpLike = [];
  for (let i = 0; i < N + 1; i++) {
    const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: 700 });
    await p.goto(`chrome-extension://${id}/${path}`, { waitUntil: 'load' });
    await p.waitForTimeout(150);
    const v = await p.evaluate(() => ({ fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0, load: performance.getEntriesByType('navigation')[0].loadEventEnd }));
    if (i) { fcp.push(v.fcp); lcpLike.push(v.load); }
    await p.close();
  }
  console.log(`${name.padEnd(8)} FCP median ${Math.round(med(fcp))} ms   load median ${Math.round(med(lcpLike))} ms`);
}
await ctx.close();
