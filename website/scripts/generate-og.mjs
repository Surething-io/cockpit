#!/usr/bin/env node
/**
 * Generate `public/og.png` (1200×630) from an inline SVG template.
 *
 * Runs as part of `npm run build` (see package.json). Uses `sharp` from the
 * parent project's node_modules — the website doesn't ship sharp itself.
 *
 * Why pre-render instead of using Next's ImageResponse:
 * - We use `output: 'export'` (Cloudflare Pages static export). ImageResponse
 *   under static export is fragile across Next versions; a plain PNG file is
 *   the most portable contract for Twitter / Slack / WeChat / Telegram bots.
 *
 * To regenerate manually:
 *   node scripts/generate-og.mjs
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(__dirname, '..');
const projectRoot = resolve(websiteRoot, '..');
const outDir = join(websiteRoot, 'public');
const outPath = join(outDir, 'og.png');

// Resolve `sharp` from either the website's own node_modules or the parent
// project's. The parent project already ships sharp as a devDependency.
const require = createRequire(import.meta.url);
let sharp;
for (const candidate of [websiteRoot, projectRoot]) {
  try {
    sharp = require(join(candidate, 'node_modules/sharp/lib/index.js'));
    break;
  } catch {
    // try next
  }
}
if (!sharp) {
  // Last resort: regular resolution
  try {
    sharp = require('sharp');
  } catch (err) {
    console.warn(
      '[og] sharp is not installed — skipping OG image generation. ' +
        'Install it in either ./website or the parent repo to enable.',
    );
    process.exit(0);
  }
}

const W = 1200;
const H = 630;

// SVG template — bg gradient inspired by Radix Teal-9, "cockpit" feel.
// Keep this self-contained (no external fonts) so any environment can render it.
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="60%" stop-color="#0e2724"/>
      <stop offset="100%" stop-color="#0d1f1d"/>
    </linearGradient>
    <radialGradient id="glow" cx="20%" cy="0%" r="80%">
      <stop offset="0%" stop-color="#12a594" stop-opacity="0.35"/>
      <stop offset="60%" stop-color="#12a594" stop-opacity="0.0"/>
    </radialGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#12a594"/>
      <stop offset="100%" stop-color="#9eeae0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- subtle dotted grid -->
  <g fill="#1f2a30" opacity="0.5">
    ${Array.from({ length: 24 })
      .map((_, i) =>
        Array.from({ length: 13 })
          .map(
            (_, j) =>
              `<circle cx="${60 + i * 50}" cy="${60 + j * 45}" r="1.4"/>`,
          )
          .join(''),
      )
      .join('\n    ')}
  </g>

  <!-- top badge -->
  <g transform="translate(80, 90)">
    <rect x="0" y="0" rx="14" ry="14" width="380" height="40" fill="#0a1f1c" stroke="#12a594" stroke-opacity="0.4"/>
    <circle cx="22" cy="20" r="5" fill="#12a594"/>
    <text x="38" y="26" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" fill="#9eeae0">
      Built on Claude Code Agent SDK
    </text>
  </g>

  <!-- headline -->
  <text x="80" y="240" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif" font-size="76" font-weight="800" fill="#f7f9fa" letter-spacing="-2">
    Cockpit
  </text>
  <text x="80" y="320" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif" font-size="42" font-weight="700" fill="#e6edf3" letter-spacing="-0.6">
    A Claude Code GUI for
  </text>
  <text x="80" y="372" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif" font-size="42" font-weight="700" fill="url(#accent)" letter-spacing="-0.6">
    parallel AI coding.
  </text>

  <!-- tagline -->
  <text x="80" y="430" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif" font-size="22" fill="#9aa6b2">
    One seat. One AI. Everything under control.
  </text>

  <!-- divider -->
  <line x1="80" y1="475" x2="${W - 80}" y2="475" stroke="#1f2a30" stroke-width="1"/>

  <!-- features row -->
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" fill="#9eeae0">
    <text x="80"  y="525">▶ Multi-project</text>
    <text x="320" y="525">▶ Terminal</text>
    <text x="500" y="525">▶ Browser</text>
    <text x="680" y="525">▶ DBs</text>
    <text x="800" y="525">▶ /qa /fx /review</text>
  </g>

  <!-- bottom row: install + url -->
  <g transform="translate(80, 555)">
    <rect x="0" y="0" rx="10" ry="10" width="430" height="44" fill="#0a1f1c" stroke="#1f2a30"/>
    <text x="20" y="29" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="17" fill="#e6edf3">
      $ npm i -g @surething/cockpit
    </text>
  </g>
  <text x="${W - 80}" y="585" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" fill="#5a6b78">
    cocking.cc
  </text>
  <text x="${W - 80}" y="610" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" fill="#3f4d57">
    MIT · open source
  </text>
</svg>
`;

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(outPath);

console.log(`[og] wrote ${outPath} (${W}×${H})`);
