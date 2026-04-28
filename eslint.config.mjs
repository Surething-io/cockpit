// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

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
    "next-env.d.ts",
    // Plain JS — not part of Next.js/TS source
    "chrome-extension/**",
    "scripts/**",
    // Standalone marketing site with its own toolchain
    "website/**",
  ]),
  ...storybook.configs["flat/recommended"],
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
