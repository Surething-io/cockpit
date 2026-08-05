#!/usr/bin/env node
// Stamp the exact Next.js version used to produce `.next-prod` into the build
// output. The prod server ships this prebuilt `.next-prod` and loads Next's
// server runtime from `node_modules/next` at runtime. Those two MUST be the
// same version: a build made by Next X served by Next Y silently breaks the
// React server renderer (e.g. "renderToPipeableStream is not implemented" on
// every request). `package.json` pins `next` to an exact version to prevent
// the skew, and server.mjs cross-checks this stamp at boot as a fail-fast
// backstop. See server.mjs `assertNextVersionMatchesBuild`.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const buildDir = join(root, '.next-prod');

if (!existsSync(buildDir)) {
  console.error('[stamp-build] .next-prod not found — run `next build` first.');
  process.exit(1);
}

const nextVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/next/package.json'), 'utf8'),
).version;

const stamp = { next: nextVersion, node: process.version, stampedAt: new Date().toISOString() };
writeFileSync(join(buildDir, 'cockpit-build.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`[stamp-build] recorded next@${nextVersion} into .next-prod/cockpit-build.json`);
