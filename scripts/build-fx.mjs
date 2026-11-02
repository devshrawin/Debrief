// Bundles the one small script every page loads first (extension/fx/theme.js): it applies the light / dark choice before the
// first paint. The effects layer of the glass design (orbs, beams, goo, metal) is gone with the glass.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'fx');
mkdirSync(out, { recursive: true });
await build({ entryPoints: { theme: join(root, 'fx/src/pages/theme.js') }, outdir: out, bundle: true, format: 'iife', minify: true, target: ['chrome116'], logLevel: 'error' });
