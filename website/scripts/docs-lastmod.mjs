#!/usr/bin/env node
/**
 * Record the last-commit date of every docs Markdown file into
 * `content/docs/lastmod.json`, which `app/sitemap.ts` reads to emit `<lastmod>`.
 *
 * Why a committed JSON file instead of computing this during the build:
 *
 * - `fs.stat` mtime is worthless on CI — a fresh clone stamps every file with
 *   the checkout time, so every URL would claim it changed on every deploy.
 *   Google demotes a sitemap whose lastmod it learns to distrust.
 * - `git log` is accurate but the build host may have a shallow clone, so the
 *   dates would silently collapse onto one commit.
 *
 * So this runs on a developer machine with full history and its output is
 * committed. Re-run it (`npm run lastmod`) after editing docs content.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const websiteRoot = join(__dirname, '..');
const docsRoot = join(websiteRoot, 'content', 'docs');
const repoRoot = join(websiteRoot, '..');

/** All `*.<locale>.md` files under content/docs, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = walk(docsRoot);
/** slug -> newest commit date across that slug's per-locale files. */
const bySlug = {};

for (const file of files) {
  const rel = relative(repoRoot, file);
  let iso;
  try {
    iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', rel], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    iso = '';
  }
  if (!iso) {
    console.warn(`[lastmod] no git history for ${rel} — skipped`);
    continue;
  }
  // `content/docs/agent/skills.en.md` -> `agent/skills`
  const slug = relative(docsRoot, file).replace(/\.(en|zh)\.md$/, '');
  if (!bySlug[slug] || iso > bySlug[slug]) bySlug[slug] = iso;
}

const sorted = Object.fromEntries(Object.entries(bySlug).sort(([a], [b]) => a.localeCompare(b)));
const target = join(docsRoot, 'lastmod.json');
writeFileSync(target, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`[lastmod] wrote ${Object.keys(sorted).length} entries to ${relative(websiteRoot, target)}`);
