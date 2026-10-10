/**
 * Tripwire for waitForSdkChildExit (sdkLoop.ts), which reaches into the Claude Agent
 * SDK's non-public ProcessTransport. If an SDK upgrade moves these members, the wait
 * degrades to a no-op silently — this test makes the upgrade fail instead.
 *
 * Checked on the installed bundle's source, not by running a query: a real query spawns
 * the Claude Code CLI.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { waitForSdkChildExit } from './sdkLoop';

// Read straight off disk (like scripts/check-agents.mjs): the SDK's `exports` map
// does not expose its files to require.resolve.
const REPO_ROOT = join(__dirname, '../../../../../../..');
const bundle = readFileSync(join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'utf8');

describe('Claude SDK transport internals used by waitForSdkChildExit', () => {
  it('Query keeps its transport on a `transport` field', () => {
    expect(bundle).toMatch(/\{transport;/);
  });

  it('ProcessTransport has waitForExit() and tracks the child as `process`', () => {
    expect(bundle).toMatch(/async waitForExit\(\)\{[^]{0,200}this\.process\.exitCode/);
  });

  it('returns at once for a child that already exited, and is bounded otherwise', async () => {
    const exited = { transport: { process: { exitCode: 1 }, waitForExit: () => new Promise<void>(() => {}) } };
    const t0 = Date.now();
    await waitForSdkChildExit(exited, 2000);
    expect(Date.now() - t0).toBeLessThan(100);

    const hung = { transport: { process: { exitCode: null }, waitForExit: () => new Promise<void>(() => {}) } };
    const t1 = Date.now();
    await waitForSdkChildExit(hung, 50);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(45);
  });
});
