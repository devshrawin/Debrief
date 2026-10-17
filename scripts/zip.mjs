// npm run pack     -> release/Debrief-Pro-v<version>.zip   (the extension folder, built first, manifest at the root)
// npm run src-zip  -> release/Debrief-Pro-v<version>-source.zip   (the source, without node_modules, release, .git, extension/dist)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const version = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).version;
const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });

// Windows ships bsdtar (which writes zip) in System32; elsewhere use zip.
function zip(out, cwd, excludes = []) {
  fs.rmSync(out, { force: true });
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', out, ...excludes.map((e) => `--exclude=${e}`), '.'], { cwd, stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-r', '-q', out, '.', ...excludes.flatMap((e) => ['-x', `${e}/*`, `*/${e}/*`])], { cwd, stdio: 'inherit' });
  }
}

if (mode === 'pack') {
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' });
  const out = path.join(outDir, `Debrief-Pro-v${version}.zip`);
  zip(out, path.join(root, 'extension'));
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
} else if (mode === 'src') {
  const out = path.join(outDir, `Debrief-Pro-v${version}-source.zip`);
  zip(out, root, ['node_modules', 'release', '.git', 'extension/dist']);
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
} else {
  console.error('usage: node scripts/zip.mjs pack|src');
  process.exit(1);
}
