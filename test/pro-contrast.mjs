// Liquid Glass accessibility: text must keep 4.5:1 on the surfaces it sits on, light and dark, including inside the floating
// panel over the worst page behind it (pure black for the light glass, pure white for the dark glass).
import fs from 'node:fs';
import assert from 'node:assert/strict';
const css = fs.readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
const lightCss = css.slice(0, darkAt);
const darkCss = css.slice(darkAt, css.indexOf(':root[data-theme="dark"]'));
const tok = (src, name) => {
  const m = new RegExp(`${name}: *(#[0-9a-fA-F]{6})`).exec(src);
  assert.ok(m, `token ${name} in ${src.slice(0, 40)}`);
  return m[1];
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = ([r, g, b]) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
let bad = 0;
const check = (label, a, b, min = 4.5) => {
  const r = ratio(a, b);
  const ok = r >= min;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} contrast ${label}: ${r.toFixed(2)}:1 (need ${min})`);
};
const panelLabel2 = { light: '#46464d', dark: '#bcbcc6' };
for (const [name, src] of [['light', lightCss], ['dark', darkCss]]) {
  const label = rgb(tok(src, '--label'));
  const label2 = rgb(name === 'light' ? tok(src, '--label-2') : tok(src, '--label-2'));
  for (const s of ['--surface-solid', '--surface-read']) {
    check(`${name} text on ${s}`, label, rgb(tok(src, s)));
    check(`${name} muted text on ${s}`, label2, rgb(tok(src, s)));
  }
  check(`${name} link on surface`, rgb(tok(src, '--tint')), rgb(tok(src, '--surface-read')));
  check(`${name} button text on tint`, rgb(tok(src, '--on-tint')), rgb(tok(src, '--tint')));
}
// the floating panel: its glass tint over the worst backdrop (see src/panel.js)
const lightGlass = over([255, 255, 255], 0.88, [0, 0, 0]);
const darkGlass = over([24, 24, 34], 0.82, [255, 255, 255]);
check('panel (light glass over black page) muted text', rgb(panelLabel2.light), lightGlass);
check('panel (dark glass over white page) muted text', rgb(panelLabel2.dark), darkGlass);
check('panel (light glass over black page) text', rgb(tok(lightCss, '--label')), lightGlass);
check('panel (dark glass over white page) text', rgb(tok(darkCss, '--label')), darkGlass);
assert.ok(css.includes(`--label-2: ${panelLabel2.light}`) && css.includes(`--label-2: ${panelLabel2.dark}`), 'panel muted colours match style.css');
assert.equal(bad, 0, `${bad} contrast pair(s) below 4.5:1`);
