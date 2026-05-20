import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    wsServer:       'src/lib/wsServer.ts',
    httpApi:        'src/lib/httpApi.ts',
    scheduledTasks: 'packages/feature/agent/src/server/scheduledTasks.ts',
  },
  outDir: 'dist',
  format: 'esm',
  target: 'node20',
  platform: 'node',
  splitting: true,
  clean: true,
  // Keep node_modules external — don't bundle dependencies.
  // BUT inline @cockpit/* workspace packages: they're not published to npm,
  // so leaving them as external `import` references in dist/*.mjs would crash
  // at user runtime when wsServer / scheduledTasks dynamically resolve them
  // against the (non-existent) `node_modules/@cockpit/*`. Inlining at bundle
  // time mirrors what Next.js's `transpilePackages` does for `.next-prod/`.
  external: [/node_modules/],
  noExternal: [/^@cockpit\//],
});
