import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    wsServer:       'src/lib/wsServer.ts',
    scheduledTasks: 'packages/feature/agent/src/server/scheduledTasks.ts',
  },
  outDir: 'dist',
  format: 'esm',
  target: 'node20',
  platform: 'node',
  splitting: true,
  clean: true,
  // Keep node_modules external — don't bundle dependencies
  external: [/node_modules/],
  noExternal: [],
});
