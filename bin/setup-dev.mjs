#!/usr/bin/env node
/**
 * Selective symlink for `cockpit-dev` — installs ONLY the dev binary as
 * a live symlink to local source, without touching the global `cockpit`
 * / `cock` binaries which come from `npm install -g @surething/cockpit`.
 *
 * Why not `npm link`:
 *   `npm link` is all-or-nothing — it overrides ALL package.json `bin`
 *   entries (cockpit, cock, cockpit-dev) with symlinks to local source.
 *   That means your prod `cockpit` becomes the dev source too, and any
 *   broken commit in the repo immediately breaks production usage. The
 *   `unlink` / `install -g` dance to recover is friction.
 *
 *   This script avoids that by symlinking JUST `cockpit-dev`. Result:
 *     - `cockpit`      → unchanged (npm-installed, stable, follows releases)
 *     - `cock`         → unchanged (npm-installed, prod alias)
 *     - `cockpit-dev`  → symlink → /<repo>/bin/cockpit-dev.mjs (live)
 *
 *   You never need to "unlink"; the symlink coexists with the npm install
 *   peacefully and `npm i -g @surething/cockpit@latest` to upgrade prod
 *   leaves the dev symlink untouched.
 *
 * Idempotent: replaces an existing symlink/file if present.
 *
 * Run from the cockpit repo root: `npm run setup-dev`
 */
import { existsSync, lstatSync, unlinkSync, symlinkSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE = resolve(REPO_ROOT, 'bin/cockpit-dev.mjs');

if (!existsSync(SOURCE)) {
  console.error(`✗ Source not found: ${SOURCE}`);
  console.error(`  Are you running from the cockpit repo? cwd=${process.cwd()}`);
  process.exit(1);
}

// Resolve the bin dir from process.execPath rather than `npm config get
// prefix`. Why: `sudo npm run setup-dev` runs npm under root's env, where
// `npm config get prefix` can resolve to a DIFFERENT path than the user's
// non-sudo npm (because of /root/.npmrc, HOME differences, or sudo's
// secure_path stripping). process.execPath is just `node`'s own absolute
// path — node lives at `<prefix>/bin/node` on every normal install
// (brew, nvm, manual), so `dirname(dirname(execPath))` gives the right
// prefix regardless of sudo.
//
// Override with COCKPIT_BIN_DIR=... if you've got an exotic layout.
const BIN_DIR = process.env.COCKPIT_BIN_DIR || dirname(process.execPath);
const TARGET = resolve(BIN_DIR, 'cockpit-dev');

// Ensure source is executable.
try {
  chmodSync(SOURCE, 0o755);
} catch {
  /* non-fatal */
}

// Replace existing symlink/file if any.
if (existsSync(TARGET) || (() => { try { return lstatSync(TARGET).isSymbolicLink(); } catch { return false; } })()) {
  try {
    unlinkSync(TARGET);
  } catch (err) {
    console.error(`✗ Could not remove existing ${TARGET}:`, err?.message);
    console.error(`  You may need: sudo rm ${TARGET}`);
    process.exit(1);
  }
}

try {
  symlinkSync(SOURCE, TARGET, 'file');
} catch (err) {
  if (err?.code === 'EACCES' || err?.code === 'EPERM') {
    console.error(`✗ Permission denied creating ${TARGET}`);
    console.error(`  Run with sudo: sudo npm run setup-dev`);
    console.error(`  Or one-liner:  sudo ln -sf ${SOURCE} ${TARGET}`);
    console.error(`  Or override:   COCKPIT_BIN_DIR=~/.local/bin npm run setup-dev`);
    process.exit(1);
  }
  console.error(`✗ Failed:`, err?.message);
  process.exit(1);
}

console.log(`✓ Linked ${TARGET}`);
console.log(`           → ${SOURCE}`);
console.log('');
console.log('Now usable:');
console.log('  cockpit-dev --version              # should report current local version');
console.log('  cockpit-dev codegraph search foo   # talks to dev server on port 3456');
console.log('');
console.log('Edits to bin/*.mjs are live (no rerun needed).');
console.log('Prod `cockpit` / `cock` are untouched — they still come from your npm install.');
