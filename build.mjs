import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['background', 'popup', 'offscreen', 'options', 'mom', 'pill', 'panel', 'welcome', 'askpage'].map((n) => `src/${n}.js`).concat(['src/voice/worker.js']),
  outdir: 'extension/dist',
  entryNames: '[name]',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  loader: { '.gs': 'text' },
  logLevel: 'info',
};

// The speaker model's WebAssembly runtime is loaded from the extension folder at run time.
fs.mkdirSync('extension/vendor/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) fs.copyFileSync(`node_modules/onnxruntime-web/dist/${f}`, `extension/vendor/ort/${f}`);

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
