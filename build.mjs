import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['background', 'popup', 'offscreen', 'options', 'mom', 'pill', 'mini'].map((n) => `src/${n}.js`),
  outdir: 'extension/dist',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
