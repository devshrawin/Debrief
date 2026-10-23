// Captures every surface from real Chrome into docs/img and writes the list of files for the reviewer.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const r = spawnSync(process.execPath, ['scripts/screenshots.mjs'], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);
const dir = path.resolve('docs/img');
const files = readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => path.join(dir, f));
writeFileSync('review-shots.txt', files.join('\n') + '\n');
console.log(`${files.length} screenshots listed in review-shots.txt`);
