import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export for Cloudflare Pages
  output: 'export',
  // Disable image optimization (Cloudflare Pages serves static files)
  images: { unoptimized: true },
  // Trailing slash for cleaner static URLs
  trailingSlash: true,
  // Pin Turbopack to this directory so it doesn't traverse up to the parent
  // cockpit project's node_modules (avoids duplicate React copies that break
  // _global-error prerender).
  turbopack: {
    root: __dirname,
  },
  // Same hint for the project root resolver in non-turbopack code paths.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
