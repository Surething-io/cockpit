#!/usr/bin/env node
/**
 * Copy the pdf.js worker from node_modules into public/pdfjs/.
 *
 * Source:      node_modules/pdfjs-dist/build/pdf.worker.min.mjs
 * Destination: public/pdfjs/pdf.worker.min.mjs
 *
 * Why vendor it into public/ instead of bundling via `new URL(..., import.meta.url)`:
 * the project builds with `next build --webpack` AND runs a custom dev server,
 * and the pdf.js worker is a large standalone ESM module. Serving it as a static
 * asset from `/pdfjs/pdf.worker.min.mjs` (referenced via
 * `pdfjs.GlobalWorkerOptions.workerSrc`) is bundler-agnostic and mirrors how the
 * tree-sitter WASMs are handled (see copy-tree-sitter-wasms.mjs).
 *
 * Behaviour:
 *   - Idempotent: skips when the destination already matches by size + mtime.
 *   - Graceful: if the source is missing, logs a notice and returns without
 *     throwing (published package already vendors the file under public/pdfjs/).
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PROJECT_ROOT = join(SCRIPT_DIR, '..');

const WORKER_FILE = 'pdf.worker.min.mjs';

/**
 * Copy the pdf.js worker into `<projectRoot>/public/pdfjs/`. Idempotent.
 *
 * @param projectRoot Absolute project root. Defaults to the repo this script
 *   lives in. `bin/postinstall.mjs` passes the consuming project's root.
 * @returns true if a copy happened (or a warning was emitted); false if the
 *   destination was already up to date.
 */
export function copyPdfjsWorker(projectRoot = SCRIPT_PROJECT_ROOT) {
  const destDir = join(projectRoot, 'public', 'pdfjs');
  const src = join(projectRoot, 'node_modules', 'pdfjs-dist', 'build', WORKER_FILE);
  const dst = join(destDir, WORKER_FILE);

  mkdirSync(destDir, { recursive: true });

  if (!existsSync(src)) {
    // Production install without the package present — the worker is expected
    // to be vendored in public/pdfjs/ from the published package.
    if (!existsSync(dst)) {
      console.warn(
        '[copy-pdfjs-worker] pdfjs-dist not installed and worker missing in public/pdfjs/. ' +
          'PDF preview will be unavailable.',
      );
    }
    return false;
  }

  if (existsSync(dst)) {
    const a = statSync(src);
    const b = statSync(dst);
    if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000) {
      console.log('[copy-pdfjs-worker] worker already up to date');
      return false;
    }
  }

  copyFileSync(src, dst);
  console.log(`[copy-pdfjs-worker] ✓ ${WORKER_FILE}`);
  return true;
}

// Run as CLI when invoked directly (`node scripts/copy-pdfjs-worker.mjs`).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  copyPdfjsWorker();
}
