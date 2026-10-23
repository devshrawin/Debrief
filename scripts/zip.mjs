// Everything goes to release/<YYYY-MM-DD>/ (today's date), one folder per day. See docs/VERSIONING.md.
// npm run share    -> release/<date>/Debrief-v<version>.zip   (the file to hand to someone: extension + INSTALL.txt, nothing else)
// npm run pack     -> release/Debrief-Pro-v<version>.zip   (the extension folder, built first, manifest at the root,
//                     with the dev-only "key" field removed: the Web Store assigns the extension its own ID)
// npm run src-zip  -> release/Debrief-Pro-v<version>-source.zip   (the source, without node_modules, release, .git, extension/dist)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const version = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).version;
const today = new Date();
const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const outDir = path.join(root, 'release', stamp);
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
  const stage = path.join(root, 'release', '.stage-store');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'extension'), stage, { recursive: true });
  const { key, ...manifest } = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  zip(out, stage);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
} else if (mode === 'share') {
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' });
  const out = path.join(outDir, `Debrief-v${version}.zip`);
  const stage = path.join(root, 'release', '.stage-share');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'Debrief'), { recursive: true });
  fs.cpSync(path.join(root, 'extension'), path.join(stage, 'Debrief', 'extension'), { recursive: true });
  fs.copyFileSync(path.join(root, 'NOTICE.md'), path.join(stage, 'Debrief', 'NOTICE.md'));
  fs.copyFileSync(path.join(root, 'docs', 'INSTALL-SHARE.txt'), path.join(stage, 'Debrief', 'INSTALL.txt'));
  zip(out, stage);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
} else if (mode === 'src') {
  const out = path.join(outDir, `Debrief-Pro-v${version}-source.zip`);
  zip(out, root, ['node_modules', 'release', '.git', 'extension/dist']);
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
} else {
  console.error('usage: node scripts/zip.mjs share|pack|src');
  process.exit(1);
}
