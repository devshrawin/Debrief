// Everything goes to release/<YYYY-MM-DD>/ (today's date), one folder per day. See docs/VERSIONING.md.
// npm run share    -> release/<date>/Debrief-v<version>.zip   (the file to hand to someone: extension + INSTALL.txt, nothing else)
// npm run pack     -> release/<date>/Debrief-store-v<version>.zip   (the extension folder, built first, manifest at the root,
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

// A small zip writer (deflate, forward slashes, no "./" prefixes) so the archive opens in Windows Explorer, macOS and unzip alike.
import zlib from 'node:zlib';
function walk(dir, base = dir, skip = []) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (skip.some((e) => rel === e || rel.startsWith(`${e}/`) || rel.split('/').includes(e))) continue;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base, skip));
    else out.push({ full, rel });
  }
  return out;
}
function zip(out, cwd, excludes = []) {
  fs.rmSync(out, { force: true });
  const files = walk(cwd, cwd, excludes);
  const chunks = [];
  const central = [];
  let offset = 0;
  const dt = new Date();
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
  const date = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  for (const { full, rel } of files) {
    const data = fs.readFileSync(full);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const useComp = comp.length < data.length;
    const body = useComp ? comp : data;
    const name = Buffer.from(rel, 'utf8');
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(useComp ? 8 : 0, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    chunks.push(head, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(useComp ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...chunks, cenBuf, end]));
}

if (mode === 'pack') {
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' });
  const out = path.join(outDir, `Debrief-store-v${version}.zip`);
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
