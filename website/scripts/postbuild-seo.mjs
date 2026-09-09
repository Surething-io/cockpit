#!/usr/bin/env node
/**
 * Post-processing pass over the static export in `out/`.
 *
 * Everything here operates on built HTML rather than importing the TypeScript
 * content modules, so it needs no loader, no type stripping, and can't drift
 * from what actually shipped: if a page isn't in `out/`, it isn't in the feed.
 *
 * Three passes:
 *   1. `<html lang>` — Next renders one root layout for every route in a static
 *      export, so it can't know the per-route locale and emits `lang="und"`.
 *      Here the locale is obvious from the output path.
 *   2. `llms.txt` — the emerging convention for AI crawlers/answer engines.
 *   3. `feed.xml` per locale — RSS for the blog.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'out');
const SITE_URL = 'https://opencockpit.dev';
const BRAND = 'OpenCockpit';

/** BCP-47 tag per URL-path locale segment. */
const LANG_BY_LOCALE = { en: 'en', zh: 'zh-CN' };

function walk(dir, filter) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** `out/en/blog/foo/index.html` -> `/en/blog/foo/` */
function urlPath(file) {
  const rel = relative(outDir, file).split(sep).join('/');
  return `/${rel.replace(/index\.html$/, '')}`;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const htmlFiles = walk(outDir, (f) => f.endsWith('.html'));

// ── Pass 1: <html lang> ────────────────────────────────────────────────────
let langFixed = 0;
for (const file of htmlFiles) {
  const path = urlPath(file);
  const seg = path.split('/')[1];
  // Files outside a locale prefix (`/404.html`, the `/` redirect stub) describe
  // English chrome, and `x-default` points at /en/ anyway.
  const lang = LANG_BY_LOCALE[seg] ?? 'en';
  const html = readFileSync(file, 'utf8');
  if (!html.includes('lang="und"')) continue;
  writeFileSync(file, html.replaceAll('lang="und"', `lang="${lang}"`));
  langFixed += 1;
}
console.log(`[seo] <html lang> rewritten in ${langFixed}/${htmlFiles.length} files`);

// ── Collect page metadata for the remaining passes ─────────────────────────
/** @type {{path:string, title:string, description:string, locale:string, date?:string}[]} */
const pages = [];
for (const file of htmlFiles) {
  const path = urlPath(file);
  if (path.endsWith('.txt/') || path.includes('/_next/')) continue;
  const html = readFileSync(file, 'utf8');
  // `/[locale]/docs/` and friends are `<meta http-equiv="refresh">` stubs with
  // no content of their own — listing them would send a reader to a bounce.
  if (/http-equiv="refresh"/i.test(html)) continue;
  const title = decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '')
    // Titles carry the `%s · Section · OpenCockpit` template; in a list that is
    // already all-OpenCockpit the suffix is pure noise.
    .replace(/\s*·\s*(Documentation|Blog|文档|博客)?\s*·?\s*OpenCockpit\s*$/, '')
    .trim();
  const description = decodeEntities(
    html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '',
  );
  // BlogPosting JSON-LD carries the real publish date; docs pages have none.
  const date = html.match(/"datePublished":"([^"]+)"/)?.[1];
  const locale = path.split('/')[1];
  if (!title) continue;
  pages.push({ path, title, description, locale, date });
}

// ── Pass 2: llms.txt ───────────────────────────────────────────────────────
function section(heading, list) {
  if (!list.length) return '';
  const lines = list
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((p) => `- [${p.title}](${SITE_URL}${p.path})${p.description ? `: ${p.description}` : ''}`);
  return `## ${heading}\n\n${lines.join('\n')}\n\n`;
}

const en = pages.filter((p) => p.locale === 'en');
const llms =
  `# ${BRAND}\n\n` +
  `> ${BRAND} is an open-source (MIT) GUI for Claude Code and other coding agents ` +
  `— Codex, DeepSeek, GLM, Kimi and local Ollama models. It runs locally as a ` +
  `web client/server: parallel agent sessions across projects, a file explorer ` +
  `with git and LSP, a built-in terminal, Chrome automation and database ` +
  `bubbles, and a code graph for agent-driven exploration.\n\n` +
  `Install: \`npm i -g @surething/cockpit\` then run \`cockpit\`. ` +
  `Source: https://github.com/Surething-io/cockpit\n\n` +
  `Chinese versions of every page below live at the same path under /zh/.\n\n` +
  section('Docs', en.filter((p) => p.path.includes('/docs/'))) +
  section('Blog', en.filter((p) => p.path.includes('/blog/'))) +
  section(
    'Other',
    en.filter((p) => !p.path.includes('/docs/') && !p.path.includes('/blog/')),
  );
writeFileSync(join(outDir, 'llms.txt'), llms);
console.log(`[seo] llms.txt written (${en.length} English pages indexed)`);

// ── Pass 3: RSS per locale ─────────────────────────────────────────────────
for (const [locale, lang] of Object.entries(LANG_BY_LOCALE)) {
  const items = pages
    .filter((p) => p.locale === locale && p.date && /\/blog\/[^/]+\/$/.test(p.path))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!items.length) continue;
  const body = items
    .map(
      (p) => `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${SITE_URL}${p.path}</link>
      <guid isPermaLink="true">${SITE_URL}${p.path}</guid>
      <pubDate>${new Date(p.date).toUTCString()}</pubDate>
      <description>${escapeXml(p.description)}</description>
    </item>`,
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${BRAND} Blog</title>
    <link>${SITE_URL}/${locale}/blog/</link>
    <description>Notes on ${BRAND} — the open Claude Code GUI.</description>
    <language>${lang}</language>
    <lastBuildDate>${new Date(items[0].date).toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/${locale}/feed.xml" rel="self" type="application/rss+xml" />
${body}
  </channel>
</rss>
`;
  writeFileSync(join(outDir, locale, 'feed.xml'), xml);
  console.log(`[seo] /${locale}/feed.xml written (${items.length} posts)`);
}
