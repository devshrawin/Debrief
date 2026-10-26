// Pre-flight for the Chrome Web Store: fails (exit 1) on anything that commonly gets an extension rejected or flagged.
// Runs inside `npm run pack` and `npm run share`; also `npm run store-check`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
let bad = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(ext);
const code = files.filter((f) => /\.(js|html)$/.test(f) && !/[\/](vendor|models)[\/]/.test(f));

// 1. manifest basics
check('manifest_version 3', manifest.manifest_version === 3);
check('version matches package.json', manifest.version === JSON.parse(read('package.json')).version, `${manifest.version} vs package.json`);
check('version is numeric x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version));
check('name ≤ 75 characters', manifest.name.length <= 75);
check('description ≤ 132 characters', manifest.description.length <= 132, String(manifest.description.length));
for (const s of [16, 32, 48, 128]) check(`icon ${s}px exists`, fs.existsSync(path.join(ext, manifest.icons?.[s] || 'missing')));
check('CSP has no unsafe-eval', !/unsafe-eval/.test(manifest.content_security_policy?.extension_pages || '') || /wasm-unsafe-eval/.test(manifest.content_security_policy.extension_pages) && !/'unsafe-eval'/.test(manifest.content_security_policy.extension_pages));
check('web-accessible resources use dynamic URLs', (manifest.web_accessible_resources || []).every((r) => r.use_dynamic_url === true));

// 2. no remote code
const evalHits = code.filter((f) => /\beval\(|new Function\(/.test(fs.readFileSync(f, 'utf8')));
check('no eval / new Function in extension code', !evalHits.length, evalHits.map((f) => path.relative(root, f)).join(', '));
const remote = files.filter((f) => f.endsWith('.html')).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => `${path.basename(f)}: ${m[0].slice(0, 80)}`));
check('no remote scripts or stylesheets in pages', !remote.length, remote.join('; '));
const importHttp = code.filter((f) => /importScripts\(\s*['"]https?:|import\(\s*['"]https?:/.test(fs.readFileSync(f, 'utf8')));
check('no remote import()/importScripts', !importHttp.length);

// 3. every permission is actually used (unused permissions are the classic review question)
const used = { tabCapture: /chrome\.tabCapture/, offscreen: /chrome\.offscreen/, storage: /chrome\.storage/, unlimitedStorage: /unlimitedStorage|indexedDB/, activeTab: /action\.onClicked|tabCapture\.getMediaStreamId/, scripting: /chrome\.scripting/, notifications: /chrome\.notifications/ };
const all = code.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
for (const p of manifest.permissions || []) check(`permission "${p}" is used`, !used[p] || used[p].test(all));
for (const p of manifest.permissions || []) check(`permission "${p}" is explained in CHROMEWEBSTORE.md`, read('CHROMEWEBSTORE.md').includes('`' + p + '`'));

// 4. store listing material
const listing = read('CHROMEWEBSTORE.md');
const short = (listing.match(/## Short description[^\n]*\n([^\n]+)/) || [])[1] || '';
check('short description ≤ 132 characters', short.length > 0 && short.length <= 132, String(short.length));
check('privacy policy file exists', fs.existsSync(path.join(root, 'PRIVACY.md')));
check('listing says it is not affiliated with Google/Zoom/Microsoft', /not affiliated/i.test(listing));
for (const f of files.filter((f) => /docs[\/]img[\/]store-/.test(f) || false)) void f;
const shots = fs.readdirSync(path.join(root, 'docs', 'img')).filter((f) => /^store-\d/.test(f));
check('at least one 1280x800 screenshot', shots.some((f) => { const b = fs.readFileSync(path.join(root, 'docs', 'img', f)); return b.readUInt32BE(16) === 1280 && b.readUInt32BE(20) === 800; }));
check('screenshots are all 1280x800', shots.every((f) => { const b = fs.readFileSync(path.join(root, 'docs', 'img', f)); return b.readUInt32BE(16) === 1280 && b.readUInt32BE(20) === 800; }));

// The only place the author's GitHub may appear is the privacy policy link on the store listing (not inside the extension)
const gh = files.filter((f) => /\.(js|json|html|css)$/.test(f) && !/[\/](vendor|models)[\/]/.test(f)).filter((f) => /devshrawin/i.test(fs.readFileSync(f, 'utf8')));
check('no link to the author GitHub inside the extension (third-party licence credits are fine)', !gh.length, gh.map((f) => path.relative(root, f)).join(', '));

// 5. nothing secret or developer-only ships
const secrets = files.filter((f) => /\.(js|json|html|css)$/.test(f)).filter((f) => /AIza[0-9A-Za-z_-]{30}|sk-[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fs.readFileSync(f, 'utf8')));
check('no API keys or private keys in the package', !secrets.length, secrets.map((f) => path.relative(root, f)).join(', '));
const dev = files.filter((f) => /\.(map|md|log)$|[\/]test[\/]|\.env/.test(f));
check('no source maps, notes or tests in the package', !dev.length, dev.slice(0, 3).map((f) => path.relative(root, f)).join(', '));
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
check('package well under the 2 GB limit', bytes < 2e9, `${(bytes / 1048576).toFixed(0)} MB`);

console.log(bad ? `\n${bad} problem(s): fix before uploading.` : '\nStore pre-flight passed.');
process.exit(bad ? 1 : 0);
