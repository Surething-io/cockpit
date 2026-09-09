import type { MetadataRoute } from 'next';

// Required for `output: 'export'` (Cloudflare Pages static export).
export const dynamic = 'force-static';

/**
 * Web app manifest, served at `/manifest.webmanifest`.
 *
 * Having this file makes Next emit `<link rel="manifest">` into the server-
 * rendered `<head>`, which is the point: a manifest injected by client-side JS
 * is invisible to crawlers that don't execute scripts.
 *
 * `name` is the full brand string on purpose — "Cockpit" alone collides with
 * opencockpits.com in search. `short_name` is what shows under a home-screen
 * icon, where 12 characters is about the budget.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OpenCockpit — The Open Claude Code GUI',
    short_name: 'OpenCockpit',
    description:
      'Open-source Claude Code GUI for parallel AI coding. Multi-engine, local-first, MIT.',
    start_url: '/en/',
    scope: '/',
    display: 'standalone',
    background_color: '#111113',
    theme_color: '#111113',
    categories: ['developer', 'productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { src: '/icons/icon-96x96.png', sizes: '96x96', type: 'image/png' },
      { src: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { src: '/icons/icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { src: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
