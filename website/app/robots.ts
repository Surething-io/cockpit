import type { MetadataRoute } from 'next';

const SITE_URL = 'https://opencockpit.dev';

// Required for `output: 'export'` (Cloudflare Pages static export).
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // /try is the E2B sandbox handler — don't waste crawl budget on it.
        //
        // Nothing else is disallowed on purpose. `/_next/` used to be listed
        // here and must not come back: Googlebot renders the page, so blocking
        // the build assets hides the CSS/JS it needs to judge layout and mobile
        // friendliness. Next.js explicitly advises against it.
        disallow: ['/try', '/try/', '/try/*'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
