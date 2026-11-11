import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { captureBrowserDom } from './__tests__/browserDom';

const browser = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((path): path is string => !!path && existsSync(path));

describe.skipIf(!browser)('conversation visibility in a browser', () => {
  let directory: string;
  let results: Record<string, string>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cockpit-chat-visibility-'));
    const runtime = join(directory, 'runtime.ts');
    await writeFile(runtime, `import { Effect } from 'effect'; export const BrowserRuntime = {
      runFork: Effect.runFork, runPromise: Effect.runPromise, runPromiseExit: Effect.runPromiseExit };`);
    await build({
      entryPoints: [fileURLToPath(new URL('./__tests__/chatVisibilityBrowser.tsx', import.meta.url))],
      outfile: join(directory, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife',
      nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"development"' },
      alias: { '@cockpit/effect-runtime': runtime, '@cockpit/effect-core': resolve('packages/shared/effect-core/src/errors.ts') },
    });
    await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result">RUNNING</pre><script src="./bundle.js"></script>');
    const dom = await captureBrowserDom(browser!, directory);
    const output = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
    if (!output || output === 'RUNNING') throw new Error(`Visibility scenarios did not finish: ${directory}`);
    results = JSON.parse(output.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }, 60_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it('loads only visible conversations and preserves background work and confirmed snapshots', () => {
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(8);
    for (const [name, result] of Object.entries(results)) expect.soft(result, name).toBe('PASS');
  });
});
