import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/lib/wsServer.ts',
    'src/lib/scheduledTasks.ts',
  ],
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
