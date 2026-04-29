import type { MetadataRoute } from 'next';

const SITE_URL = 'https://cocking.cc';

// Required for `output: 'export'` (Cloudflare Pages static export).
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // /try is the E2B sandbox handler — don't waste crawl budget on it.
        disallow: ['/try', '/try/', '/try/*', '/_next/', '/__next.', '/api/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
