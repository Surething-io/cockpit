import type { MetadataRoute } from 'next';
import { locales } from '@/lib/i18n';
import { posts } from '@/content/posts';
import { getAvailablePages } from '@/content/docs/sidebar';

const SITE_URL = 'https://opencockpit.dev';

// Required for `output: 'export'` (Cloudflare Pages static export).
export const dynamic = 'force-static';

/**
 * Sitemap covering both locales for the homepage, docs, changelog, and blog.
 *
 * Each route emits hreflang `alternates` so Google groups the en/zh variants
 * as the same canonical resource — critical for our bilingual content.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  // `/docs/` is a redirect-only route, so only its canonical content pages
  // belong in the sitemap.
  const staticRoutes = ['', '/changelog', '/blog'];
  const docsPages = getAvailablePages();

  const entries: MetadataRoute.Sitemap = [];

  for (const route of staticRoutes) {
    for (const locale of locales) {
      entries.push({
        url: `${SITE_URL}/${locale}${route}/`,
        alternates: {
          languages: Object.fromEntries(
            [
              ...locales.map((l) => [l, `${SITE_URL}/${l}${route}/`]),
              ['x-default', `${SITE_URL}/en${route}/`],
            ],
          ),
        },
      });
    }
  }

  // Canonical documentation URLs (one per locale and available sidebar page).
  for (const page of docsPages) {
    for (const locale of locales) {
      entries.push({
        url: `${SITE_URL}/${locale}/docs/${page.slug}/`,
        alternates: {
          languages: Object.fromEntries([
            ...locales.map((l) => [l, `${SITE_URL}/${l}/docs/${page.slug}/`]),
            ['x-default', `${SITE_URL}/en/docs/${page.slug}/`],
          ]),
        },
      });
    }
  }

  // Per-post URLs (one per locale).
  for (const post of posts) {
    for (const locale of locales) {
      entries.push({
        url: `${SITE_URL}/${locale}/blog/${post.slug}/`,
        lastModified: post.date,
        changeFrequency: 'monthly',
        priority: 0.7,
        alternates: {
          languages: Object.fromEntries(
            [
              ...locales.map((l) => [l, `${SITE_URL}/${l}/blog/${post.slug}/`]),
              ['x-default', `${SITE_URL}/en/blog/${post.slug}/`],
            ],
          ),
        },
      });
    }
  }

  return entries;
}
