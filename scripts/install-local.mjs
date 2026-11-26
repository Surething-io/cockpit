// npm run install:local
//
// Build everything from this checkout and install it as the global cockpit,
// plus the desktop app built from the same sources:
//
//   npm run build && npm run build:server && npm run desktop:build
//   npm pack  →  npm install -g ./<tgz>  →  rm <tgz>
//   cockpit app install --from desktop/dist
//
// A node script rather than a one-line npm script so it also runs on Windows,
// where npm scripts go through cmd.exe and `TGZ=$(npm pack)` does not exist.
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

function run(cmd, args, { capture = false } = {}) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    // npm is npm.cmd on Windows, which needs a shell; every argument here is shell-safe.
    shell: isWindows && cmd === 'npm',
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${cmd} ${args.join(' ')} failed (exit ${result.status ?? 'signal'})`);
    process.exit(result.status || 1);
  }
  return capture ? result.stdout : '';
}

// Start from a cold build cache. Next's persistent webpack cache has been seen
// to keep serving CSS compiled from an older globals.css after it changed —
// the JS picked up new class names while their rules never reached the CSS.
// CI never hits this (fresh checkout; prepublishOnly drops the cache too).
rmSync(join(ROOT, '.next-prod', 'cache'), { recursive: true, force: true });
run('npm', ['run', 'build']);
run('npm', ['run', 'build:server']);
run('npm', ['run', 'desktop:build']);

// --silent leaves only the tarball name on stdout (last line, in case a
// lifecycle script printed something first).
const tgz = run('npm', ['pack', '--silent'], { capture: true }).trim().split(/\r?\n/).pop();
try {
  run('npm', ['install', '-g', `./${tgz}`]);
} finally {
  rmSync(join(ROOT, tgz), { force: true });
}

// Same version as the package just installed, so the repo's own CLI picks the
// matching zip from desktop/dist.
run(process.execPath, [join(ROOT, 'bin', 'cockpit.mjs'), 'app', 'install', '--from', join(ROOT, 'desktop', 'dist')]);

// The build output is an app with the same bundle id. Once macOS has seen it
// (opened once, or browsed in Finder), LaunchServices may prefer that copy and
// the installed one goes missing from the Applications list. Forget it.
if (process.platform === 'darwin') {
  const { registerWithLaunchServices } = await import('../bin/cock-app.mjs');
  await registerWithLaunchServices(join(ROOT, 'desktop', 'dist', 'mac-arm64', 'OpenCockpit.app'), { unregister: true });
  await registerWithLaunchServices(join(ROOT, 'desktop', 'dist', 'mac', 'OpenCockpit.app'), { unregister: true });
}

console.log('\n✓ Installed cockpit and the OpenCockpit desktop app from this checkout.');
console.log('  A running server keeps the old code until `cockpit restart`; a running app until it is reopened.');
