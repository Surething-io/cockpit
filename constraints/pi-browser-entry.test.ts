// The thinking control's provider check must not import native paths into the browser.
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('bundles the Pi thinking hook for browsers without Node builtin shims', async () => {
  const result = await build({
    entryPoints: ['packages/feature/agent/src/client/usePiThinking.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    // Isolate the provider identity dependency from React, Effect and the HTTP client.
    external: ['react', 'effect', '@cockpit/effect-react', './effect/agentClient'],
  });
  expect(result.errors).toEqual([]);
  expect(result.outputFiles[0].text).not.toContain('homedir');
});
