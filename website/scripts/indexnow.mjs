#!/usr/bin/env node
/**
 * Tell IndexNow search engines (Bing, Yandex, Seznam, ...) which pages changed
 * in the deploy that just went live.
 *
 *   node scripts/indexnow.mjs --previous <old-sitemap.xml> [--dry-run]
 *   node scripts/indexnow.mjs --urls <url>[,<url>...]     [--dry-run]
 *
 * `--previous` diffs the live sitemap saved before the deploy against the
 * freshly built `out/sitemap.xml` and submits every URL that is new or whose
 * `<lastmod>` moved. That keeps submissions honest — re-pinging unchanged
 * pages on every deploy is what gets an IndexNow key ignored — and it is only
 * as accurate as `<lastmod>`, which is why `npm run lastmod` must be re-run
 * after editing docs.
 *
 * Changes that `<lastmod>` cannot see (a title in `content/messages.ts`, say)
 * need an explicit `--urls` push.
 *
 * The key is the `<32 hex>.txt` file in `public/`; IndexNow verifies ownership
 * by fetching it from the site root, so it is public by design.
 *
 * Never fails the deploy: a missing baseline, a network error or a rejected
 * request is reported as a GitHub Actions warning and the script exits 0.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE = 'https://opencockpit.dev';
const HOST = new URL(SITE).host;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10_000; // IndexNow's per-request limit

const websiteRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const dryRun = args.includes('--dry-run');

const warn = (message) => {
  // `::warning::` surfaces in the Actions run summary; harmless locally.
  console.log(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}[indexnow] ${message}`);
};

function readKey() {
  const files = readdirSync(`${websiteRoot}public`).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (files.length !== 1) throw new Error(`expected exactly one <32 hex>.txt key file in public/, found ${files.length}`);
  const key = files[0].slice(0, -4);
  const content = readFileSync(`${websiteRoot}public/${files[0]}`, 'utf8').trim();
  if (content !== key) throw new Error(`public/${files[0]} must contain exactly its own key`);
  return key;
}

/** `<loc>` → `<lastmod>` for every `<url>` entry. */
function parseSitemap(xml) {
  const entries = new Map();
  for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (loc) entries.set(loc, block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? '');
  }
  return entries;
}

function changedUrls(previousPath) {
  if (!existsSync(previousPath)) {
    warn(`no previous sitemap at ${previousPath}; skipping rather than submitting every page`);
    return [];
  }
  const before = parseSitemap(readFileSync(previousPath, 'utf8'));
  if (before.size === 0) {
    warn('previous sitemap has no <url> entries; skipping rather than submitting every page');
    return [];
  }
  const after = parseSitemap(readFileSync(`${websiteRoot}out/sitemap.xml`, 'utf8'));
  return [...after].filter(([loc, lastmod]) => before.get(loc) !== lastmod).map(([loc]) => loc);
}

async function main() {
  const key = readKey();
  const previous = flag('--previous');
  const explicit = flag('--urls');
  if (!previous === !explicit) throw new Error('pass exactly one of --previous <file> or --urls <list>');

  const urls = previous ? changedUrls(previous) : explicit.split(',').map((u) => u.trim()).filter(Boolean);
  const foreign = urls.filter((u) => new URL(u).host !== HOST);
  if (foreign.length) throw new Error(`URLs outside ${HOST}: ${foreign.join(', ')}`);
  if (urls.length === 0) {
    console.log('[indexnow] Nothing changed; no submission');
    return;
  }

  const urlList = urls.slice(0, MAX_URLS);
  console.log(`[indexnow] ${dryRun ? 'Would submit' : 'Submitting'} ${urlList.length} URL(s):`);
  for (const url of urlList) console.log(`  ${url}`);
  if (dryRun) return;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key, keyLocation: `${SITE}/${key}.txt`, urlList }),
  });
  // 200 = accepted, 202 = accepted while the key is still being verified.
  if (response.status === 200 || response.status === 202) {
    console.log(`[indexnow] Accepted (HTTP ${response.status})`);
  } else {
    warn(`submission rejected: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
}

main().catch((error) => {
  warn(`skipped: ${error.message}`);
});
