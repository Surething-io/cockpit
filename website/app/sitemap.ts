import type { MetadataRoute } from 'next';
import { locales } from '@/lib/i18n';
import { posts } from '@/content/posts';

const SITE_URL = 'https://cocking.cc';

// Required for `output: 'export'` (Cloudflare Pages static export).
export const dynamic = 'force-static';

/**
 * Sitemap covering both locales for the homepage, docs, changelog, and blog.
 *
 * Each route emits hreflang `alternates` so Google groups the en/zh variants
 * as the same canonical resource — critical for our bilingual content.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes = ['', '/docs', '/changelog', '/blog'];

  const entries: MetadataRoute.Sitemap = [];

  for (const route of staticRoutes) {
    for (const locale of locales) {
      entries.push({
        url: `${SITE_URL}/${locale}${route}/`,
        lastModified: now,
        changeFrequency: route === '' ? 'weekly' : 'weekly',
        priority: route === '' ? 1.0 : 0.8,
        alternates: {
          languages: Object.fromEntries(
            locales.map((l) => [l, `${SITE_URL}/${l}${route}/`]),
          ),
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
            locales.map((l) => [l, `${SITE_URL}/${l}/blog/${post.slug}/`]),
          ),
        },
      });
    }
  }

  return entries;
}
