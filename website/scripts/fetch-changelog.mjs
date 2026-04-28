#!/usr/bin/env node
/**
 * Build-time fetch of GitHub Releases for the changelog page.
 *
 * Output: data/changelog.json
 *
 * - Runs in `npm run build` before `next build`
 * - Falls back to an empty list on network failure (build never breaks)
 * - Honors GITHUB_TOKEN if set (raises rate limit from 60 → 5000/hour)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'changelog.json');

const REPO = 'Surething-io/cockpit';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=50`;

const headers = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cockpit-website-build',
};
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

function emit(releases) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(releases, null, 2) + '\n');
  console.log(`[fetch-changelog] wrote ${releases.length} releases → ${OUT_PATH}`);
}

try {
  console.log(`[fetch-changelog] GET ${API}`);
  const res = await fetch(API, { headers });
  if (!res.ok) {
    console.warn(`[fetch-changelog] ${res.status} ${res.statusText} — writing empty list`);
    emit([]);
    process.exit(0);
  }
  const raw = await res.json();
  const releases = raw
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      url: r.html_url,
      body: r.body || '',
      prerelease: !!r.prerelease,
    }));
  emit(releases);
} catch (err) {
  console.warn(`[fetch-changelog] error: ${err?.message ?? err} — writing empty list`);
  emit([]);
}
