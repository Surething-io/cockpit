// Build the desktop app with electron-builder, pinned to the npm package's
// version and stamped with the shell fingerprint (see shellHash.mjs), which the
// running app compares against the npm package to decide whether it needs an
// update at all. Extra arguments pass straight through, e.g.:
//
//   node desktop/scripts/build.mjs                 # this OS, this arch
//   node desktop/scripts/build.mjs --mac --arm64 --x64
//   node desktop/scripts/build.mjs --win --x64
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { shellHash } from './shellHash.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DESKTOP, '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const isWindows = process.platform === 'win32';
const builder = join(DESKTOP, 'node_modules', '.bin', isWindows ? 'electron-builder.cmd' : 'electron-builder');

const hash = shellHash(ROOT);

console.log(`Building OpenCockpit desktop ${version} (shell ${hash})`);
const result = spawnSync(
  builder,
  [
    '--config',
    'electron-builder.config.cjs',
    `-c.extraMetadata.version=${version}`,
    `-c.extraMetadata.shellHash=${hash}`,
    '--publish',
    'never',
    ...process.argv.slice(2),
  ],
  // .cmd shims need a shell on Windows; every argument above is shell-safe.
  { cwd: DESKTOP, stdio: 'inherit', shell: isWindows },
);
process.exit(result.status ?? 1);
