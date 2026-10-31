// Accessibility of the solid system: every text pair keeps 4.5:1 (body text) in the light and the dark theme. The values are read
// from the "Solid system" block at the end of extension/style.css, so changing a token without re-checking it fails here.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const css = fs.readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = css.indexOf('Solid system (side-panel redesign)');
assert.ok(start > 0, 'the Solid system block exists');
const block = css.slice(start);
const darkAt = block.indexOf('@media (prefers-color-scheme: dark)');
const lightCss = block.slice(0, darkAt);
const darkCss = block.slice(darkAt, block.indexOf(':root[data-theme="dark"]'));
const forcedDark = block.slice(block.indexOf(':root[data-theme="dark"]'));
const tok = (src, name) => {
  const m = new RegExp(`${name}: *(#[0-9a-fA-F]{6})`).exec(src);
  assert.ok(m, `token ${name} in ${src.slice(0, 40)}`);
  return m[1];
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
let bad = 0;
const check = (label, a, b, min = 4.5) => {
  const r = ratio(rgb(a), rgb(b));
  const ok = r >= min;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} contrast ${label}: ${r.toFixed(2)}:1 (need ${min})`);
};
for (const [name, src] of [['light', lightCss], ['dark', darkCss], ['dark (forced)', forcedDark]]) {
  const t = (n) => tok(src, n);
  for (const s of ['--surface-read', '--amb-base', '--fill']) {
    check(`${name} text on ${s}`, t('--label'), t(s));
    check(`${name} secondary text on ${s}`, t('--label-2'), t(s));
    check(`${name} helper text on ${s}`, t('--label-3'), t(s));
  }
  check(`${name} link on surface`, t('--tint'), t('--surface-read'));
  check(`${name} link on its soft fill`, t('--tint'), t('--tint-soft'));
  check(`${name} button text on tint`, t('--on-tint'), t('--tint'));
  check(`${name} stop button text on red`, t('--on-red'), t('--red-fill'));
  check(`${name} error text on its soft fill`, t('--red'), t('--red-soft'));
  check(`${name} error text on surface`, t('--red'), t('--surface-read'));
  check(`${name} warning text on its soft fill`, t('--orange'), t('--orange-soft'));
  check(`${name} ok text on its soft fill`, t('--green'), t('--green-soft'));
}
assert.equal(bad, 0, `${bad} contrast pair(s) below 4.5:1`);
console.log('\ncontrast ok');
