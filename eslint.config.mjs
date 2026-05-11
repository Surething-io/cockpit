import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-prod/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    // Plain JS — not part of Next.js/TS source
    "chrome-extension/**",
    "scripts/**",
    // Standalone marketing site with its own toolchain
    "website/**",
  ]),
  // ============================================================
  // 2-layer dependency rule: feature-* → shared-*
  // ============================================================
  // - feature-*: may import other @cockpit/feature-* (supporting subdomain
  //   pattern, e.g. agent → explorer for code-rendering primitives) and
  //   @cockpit/shared-*. Cycles must be avoided — the current dependency
  //   graph is acyclic (workspace → all features; agent → explorer →
  //   comments → shared-*; review/skills → comments).
  //   By convention, only feature-workspace imports across multiple
  //   features (it's the application integrator). Other features should
  //   import from another feature only when there's a clear "supporting
  //   subdomain" relationship.
  // - shared-*: leaf layer. Must NOT import any @cockpit/feature-*. Use
  //   IoC slots if host-injected behavior is needed.
  //
  // See CLAUDE.md / MODULES.md for the full architecture doc.
  {
    files: ["packages/shared/*/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@cockpit/feature-*", "@cockpit/feature-*/*"],
          message: "Shared packages are leaves and must not import from feature packages. Use IoC slots if you need host-injected behavior.",
        }],
      }],
    },
  },
  {
    rules: {
      // Allow <img> — Next.js <Image> is unnecessary for a local-only app
      "@next/next/no-img-element": "off",
      // Deps are intentionally omitted in many hooks to avoid re-fire
      "react-hooks/exhaustive-deps": "off",
      // Ref-in-render and setState-in-effect are used intentionally
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // Third-party lib compat warnings are not actionable
      "react-hooks/incompatible-library": "off",
      // Allow _prefixed unused vars (destructuring, catch, callbacks)
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
]);

export default eslintConfig;
