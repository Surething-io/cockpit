// Vitest transforms imports differently from the actual tsx development entry.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('loads the native development module graph and calls Pi through its ESM boundary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-pi-entry-'));
  try {
    const script = `
      await import('./src/lib/wsServer.ts');
      const view = await import('./packages/feature/agent/src/effect/piSessionLive.ts');
      const { Effect } = await import('effect');
      const find = view.findPiSession ?? view.default.findPiSession;
      await Effect.runPromise(find(process.cwd(), 'nonexistent-entry-probe'));
      process.stdout.write('PI_ENTRY_OK');
      process.exit(0);
    `;
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: process.cwd(), env: { ...process.env, COCKPIT_HOME: home }, timeout: 20000 });
    expect(result.stdout).toContain('PI_ENTRY_OK');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 25000);
