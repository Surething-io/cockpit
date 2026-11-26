// Record SHA-256 for every desktop build artifact.
//
//   node desktop/scripts/checksums.mjs <artifact dir>...
//
// Writes two files:
//   - <root>/desktop-checksums.json — the zips `cockpit app install` downloads,
//     plus the shell fingerprint they were built from (see shellHash.mjs).
//     Shipped inside the npm package; it vouches for the download and tells a
//     running app whether this release changes the shell at all.
//   - <first dir>/SHA256SUMS — every artifact, attached to the GitHub Release
//     for people who download a .dmg / .zip by hand.
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { shellHash } from './shellHash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: checksums.mjs <artifact dir>...');
  process.exit(2);
}

const ARTIFACT = new RegExp(`^OpenCockpit-${version.replace(/\./g, '\\.')}-(mac|win)-[\\w-]+\\.(zip|dmg)$`);
const all = {};
for (const dir of dirs) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isFile() || !ARTIFACT.test(name)) continue;
    if (all[name]) throw new Error(`duplicate artifact ${name}`);
    all[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}

const zips = Object.fromEntries(Object.entries(all).filter(([name]) => name.endsWith('.zip')));
if (Object.keys(zips).length === 0) {
  console.error(`no OpenCockpit-${version}-*.zip artifacts found in ${dirs.join(', ')}`);
  process.exit(1);
}

writeFileSync(
  join(ROOT, 'desktop-checksums.json'),
  JSON.stringify({ version, shellHash: shellHash(ROOT), files: zips }, null, 2) + '\n',
);
const sums = Object.entries(all)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, sha]) => `${sha}  ${name}`)
  .join('\n');
writeFileSync(join(dirs[0], 'SHA256SUMS'), sums + '\n');
console.log(sums);
