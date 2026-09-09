import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * The marketing site's own flat config.
 *
 * The parent repo's `eslint.config.mjs` deliberately ignores `website/**` — it
 * is a separate app with its own `package.json` and Next version — so linting
 * has to be rooted here. Until Next 16 this file's absence was masked by
 * `next lint`, which is gone; `npm run lint` now runs `eslint` directly.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    // Static export output — built artifacts, not source.
    'out/**',
    'next-env.d.ts',
    // Plain Node build scripts (icon copying, changelog fetch, OG rendering,
    // post-export SEO passes). Not part of the Next app.
    'scripts/**',
  ]),
]);

export default eslintConfig;
