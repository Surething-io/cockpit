import { describe, it, expect } from 'vitest';
import { sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { CodexAppServerClient, CodexAppServerError, type CodexNotification } from './client';

/**
 * Tear a client down and wait for its process to be gone. `dispose()` alone
 * returns while the child is still alive (Windows kills it via an async
 * `taskkill`), and the next test's server starting on the same CODEX_HOME
 * meanwhile has been seen to exit at once with code 1.
 */
async function shutDown(client: CodexAppServerClient): Promise<void> {
  client.dispose();
  await client.exited;
}

/** Re-throw with the server's stderr attached, so a CI-only failure says why. */
async function withStderr<T>(stderr: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error && stderr.length) err.message += `\n--- codex stderr ---\n${stderr.join('\n')}`;
    throw err;
  }
}

/**
 * These drive a real `codex app-server` child. No model call is made — the
 * handshake and an ephemeral thread are enough to prove the framing, and they
 * cost nothing and need no credentials beyond what the machine already has.
 */
describe('CodexAppServerClient', () => {
  it('completes the handshake and opens a thread', async () => {
    const notes: CodexNotification[] = [];
    const stderr: string[] = [];
    const client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      onNotification: (n) => notes.push(n),
      onStderr: (line) => stderr.push(line),
    });
    try {
      await withStderr(stderr, async () => {
        const init = await client.request('initialize', {
          clientInfo: { name: 'cockpit-test', title: 'cockpit-test', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        });
        expect(typeof init.userAgent).toBe('string');
        expect(typeof init.codexHome).toBe('string');

        // Params-less notification, and it must precede any thread/* call.
        client.notify('initialized');

        const started = await client.request('thread/start', {
          cwd: process.cwd(),
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: true,
        });
        const thread = started.thread as { id?: string; ephemeral?: boolean };
        expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(thread.ephemeral).toBe(true);
      });
    } finally {
      await shutDown(client);
    }
  }, 30_000);

  it('rejects an unknown method with the server error, not a hang', async () => {
    const stderr: string[] = [];
    const client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      onNotification: () => {},
      onStderr: (line) => stderr.push(line),
    });
    try {
      await withStderr(stderr, async () => {
        await client.request('initialize', {
          clientInfo: { name: 'cockpit-test', title: 'cockpit-test', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        });
        // A JSON-RPC error carries a code; a dead transport does not. Without
        // this, the server simply exiting would also count as "rejected".
        const err = await client.request('thread/doesNotExist', {}).then(
          () => { throw new Error('expected thread/doesNotExist to be rejected'); },
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(CodexAppServerError);
        expect((err as CodexAppServerError).code).toEqual(expect.any(Number));
      });
    } finally {
      await shutDown(client);
    }
  }, 30_000);

  /**
   * The failure this pins: with no settle-on-exit, a dead child leaves the turn
   * awaiting a reply that can never arrive and the run hangs instead of erroring.
   */
  it('settles in-flight requests when the child goes away', async () => {
    const client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      onNotification: () => {},
    });
    const inFlight = client.request('initialize', {
      clientInfo: { name: 'cockpit-test', title: 'cockpit-test', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.dispose();
    await expect(inFlight).rejects.toThrow(/disposed|exited/);
    await client.exited;
  }, 30_000);
});
