import { defineConfig } from 'vitest/config';

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
  },
});
