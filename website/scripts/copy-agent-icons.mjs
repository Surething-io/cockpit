#!/usr/bin/env node
/**
 * Copy the engine logos from the app into the website's public/ tree.
 *
 * Source:      ../public/agent-icons/*.svg   (the app's, and the only originals)
 * Destination: public/agent-icons/*.svg
 *
 * The website is a separate Next app with its own public/, so it cannot reference
 * the app's assets directly. It could keep its own hand-placed copies — but the
 * whole point of these logos is that the mark on the marketing page is the mark
 * in the product, and a second set of files is exactly how that stops being true.
 * (It already nearly did: the Kimi logo shipped as a white-on-dark variant and had
 * to be recolored; a forgotten copy here would still be serving the old one.)
 *
 * Runs on predev and prebuild, mirroring the root project's copy-* scripts.
 *
 * Behaviour:
 *   - Idempotent: compares bytes, not mtime. copyFileSync does not carry the
 *     source mtime over, so a timestamp check would report "changed" on every
 *     run. These are a few KB each — reading them is cheaper than the confusion.
 *   - Fatal if the source directory is missing: the site would otherwise deploy
 *     with broken images, which is worse than failing the build.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = join(SCRIPT_DIR, '..');

const srcDir = join(WEBSITE_ROOT, '..', 'public', 'agent-icons');
const destDir = join(WEBSITE_ROOT, 'public', 'agent-icons');

if (!existsSync(srcDir)) {
  console.error(`[copy-agent-icons] source directory missing: ${srcDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.svg'))) {
  const src = join(srcDir, file);
  const dst = join(destDir, file);

  if (existsSync(dst) && readFileSync(src).equals(readFileSync(dst))) continue;

  copyFileSync(src, dst);
  copied += 1;
  console.log(`[copy-agent-icons] ✓ ${file}`);
}

if (copied === 0) console.log('[copy-agent-icons] icons already up to date');
