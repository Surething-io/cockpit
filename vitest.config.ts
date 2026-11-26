import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pin NODE_ENV for the whole suite.
    //
    // Vitest only does `process.env.NODE_ENV ??= 'test'` — it will NOT overwrite an
    // inherited value. That matters because cockpit's own production server leaks
    // NODE_ENV=production into every child process it spawns (Next's `app.prepare()`
    // sets it; see packages/shared/utils/src/spawnEnv.ts). So when this suite is run
    // by an agent inside cockpit, it would silently inherit `production` and, the
    // moment a component test exists, fail with `TypeError: React.act is not a
    // function` — React only exports `act` in development builds.
    //
    // sanitizedSpawnEnv() fixes the leak at the source; this line makes the suite
    // correct regardless of who launches it.
    env: { NODE_ENV: 'test' },

    // `website/` is a separate app with its own runner: its tests are node:test
    // files run by `npm run test:seo` (`node --test`). Vitest's default include
    // matches them by filename, then reports "no test suite" and fails the whole
    // run — a green website suite showing up red here. The root tsconfig already
    // excludes the directory for the same reason.
    exclude: [...configDefaults.exclude, 'website/**'],

    // CI runners — GitHub's macOS ones above all — are several times slower
    // than a dev machine, and the CodeGraph integration tests (real git, real
    // HTTP, the real CLI) sit close to vitest's 5s default there: different
    // ones time out on different runs. Give CI headroom; keep the default
    // locally so a test that hangs still fails fast while developing.
    // GitHub Actions sets CI=true.
    testTimeout: process.env.CI ? 20_000 : 5_000,
  },
});
