#!/usr/bin/env node
/** Validate the shipped static HTML, not just generateMetadata return values. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../out/', import.meta.url));
const site = 'https://opencockpit.dev';
const read = (path) => readFileSync(`${out}${path}`, 'utf8');
const decode = (s) => s.replace(/&(amp|quot|lt|gt|#x27|#39);/g, (_, entity) => ({
  amp: '&', quot: '"', lt: '<', gt: '>', '#x27': "'", '#39': "'",
})[entity]);
function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key.toLowerCase(), decode(value)])),
  );
}
const urls = [...read('/sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
assert.ok(urls.length > 0, 'Sitemap must not be empty');
assert.equal(new Set(urls).size, urls.length, 'Duplicate sitemap URL');
const titles = new Set();
const descriptions = new Set();
const coverage = { en: { home: 0, docs: 0, doc: 0, blog: 0, post: 0 }, zh: { home: 0, docs: 0, doc: 0, blog: 0, post: 0 } };
const warnings = [];
for (const url of urls) {
  assert.ok(url.startsWith(`${site}/`), `Unexpected origin: ${url}`);
  const path = new URL(url).pathname;
  assert.ok(path.endsWith('/'), `Missing trailing slash: ${path}`);
  const [, locale, section, slug] = path.split('/');
  assert.ok(coverage[locale], `Unknown locale: ${path}`);
  const kind = !section ? 'home' : section === 'docs' ? (slug ? 'doc' : 'docs') : section === 'blog' ? (slug ? 'post' : 'blog') : null;
  if (kind) coverage[locale][kind]++;
  const html = read(`${path}index.html`);
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const metas = tags(markup, 'meta');
  const links = tags(markup, 'link');
  const meta = (key) => {
    const values = metas.filter((m) => m.name === key || m.property === key);
    assert.equal(values.length, 1, `${path}: one ${key}`);
    assert.ok(values[0].content.trim(), `${path}: empty ${key}`);
    return values[0].content;
  };
  const titleMatches = [...markup.matchAll(/<title>([^<]+)<\/title>/g)];
  assert.equal(titleMatches.length, 1, `${path}: one title`);
  const title = decode(titleMatches[0][1]);
  const description = meta('description');
  assert.ok(!titles.has(title), `${path}: duplicate title`);
  // Bing Webmaster Tools reports titles over 70 characters as an SEO error.
  assert.ok(title.length <= 70, `${path}: title is ${title.length} characters (max 70): ${title}`);
  assert.ok(!descriptions.has(description), `${path}: duplicate description`);
  titles.add(title); descriptions.add(description);
  assert.equal(tags(markup, 'h1').length, 1, `${path}: one H1`);
  assert.equal(tags(markup, 'html')[0].lang, locale === 'zh' ? 'zh-CN' : 'en', `${path}: lang`);
  assert.deepEqual(links.filter((l) => l.rel === 'canonical').map((l) => l.href), [url], `${path}: canonical`);
  assert.equal(meta('og:url'), url, `${path}: og:url`);
  assert.equal(meta('og:description'), description, `${path}: OG description`);
  assert.equal(meta('twitter:description'), description, `${path}: Twitter description`);
  const ogTitle = meta('og:title');
  assert.equal(meta('twitter:title'), ogTitle, `${path}: social title`);
  assert.ok(title === ogTitle || title.startsWith(`${ogTitle} ·`), `${path}: OG title must describe this page`);
  for (const lang of ['en', 'zh', 'x-default']) {
    const target = `${site}${path.replace(/^\/(en|zh)\//, `/${lang === 'x-default' ? 'en' : lang}/`)}`;
    assert.deepEqual(links.filter((l) => l.hreflang === lang).map((l) => l.href), [target], `${path}: ${lang} alternate`);
    assert.ok(urls.includes(target), `${path}: alternate absent from sitemap`);
  }
  assert.ok(!metas.some((m) => /robots|googlebot/.test(m.name ?? '') && /noindex/.test(m.content)), `${path}: indexable`);
  const image = meta('og:image');
  assert.equal(meta('twitter:image'), image, `${path}: social image`);
  assert.ok(existsSync(`${out}${new URL(image).pathname}`), `${path}: missing social image`);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => JSON.parse(m[1]));
  if (kind === 'post' || kind === 'doc') {
    const breadcrumb = schemas.find((s) => s['@type'] === 'BreadcrumbList');
    assert.ok(breadcrumb, `${path}: breadcrumb missing`);
    const items = breadcrumb.itemListElement;
    assert.equal(items.length, 3, `${path}: breadcrumb depth`);
    assert.equal(items.at(-1).item, url, `${path}: breadcrumb current page`);
    items.forEach((item, index) => {
      assert.equal(item.position, index + 1);
      assert.ok(urls.includes(item.item), `${path}: breadcrumb URL must exist`);
      assert.ok(markup.includes(item.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')), `${path}: breadcrumb must be visible`);
    });
  }
  if (kind === 'post') {
    const article = schemas.find((s) => s['@type'] === 'BlogPosting');
    assert.equal(article?.headline, ogTitle, `${path}: article headline`);
    assert.equal(article?.image, image, `${path}: article image`);
    assert.equal(article?.description, description);
    assert.equal(image, `${site}/og/blog/${slug}.png`, `${path}: article-specific image`);
    const png = readFileSync(`${out}/og/blog/${slug}.png`);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    if (locale === 'en' && (title.length > 60 || description.length > 160)) warnings.push(`${path}: title ${title.length}, description ${description.length}`);
  }
}
for (const [locale, counts] of Object.entries(coverage)) {
  for (const [kind, count] of Object.entries(counts)) assert.ok(count >= (kind === 'doc' || kind === 'post' ? 2 : 1), `${locale}: missing ${kind} coverage`);
}
assert.ok(!/Disallow:\s*\/try/.test(read('/robots.txt')), '/try must be crawlable');
assert.ok(!urls.some((url) => new URL(url).pathname.startsWith('/try')), '/try excluded from sitemap');
assert.ok(tags(read('/try/index.html'), 'meta').some((m) => m.name === 'robots' && /noindex/.test(m.content)), '/try fallback noindex');
assert.match(read('/_headers'), /\/_next\/static\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
for (const warning of warnings) console.warn(`[seo] Length review: ${warning}`);
console.log(`[seo] Passed ${urls.length} sitemap pages, both locales, article images, breadcrumbs, /try fallback and cache policy`);
