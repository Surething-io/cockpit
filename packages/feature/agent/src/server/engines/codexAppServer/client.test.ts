import { describe, it, expect } from 'vitest';
import { sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { CodexAppServerClient, type CodexNotification } from './client';

/**
 * These drive a real `codex app-server` child. No model call is made — the
 * handshake and an ephemeral thread are enough to prove the framing, and they
 * cost nothing and need no credentials beyond what the machine already has.
 */
describe('CodexAppServerClient', () => {
  it('completes the handshake and opens a thread', async () => {
    const notes: CodexNotification[] = [];
    const client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      onNotification: (n) => notes.push(n),
    });
    try {
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
    } finally {
      client.dispose();
    }
  }, 30_000);

  it('rejects an unknown method with the server error, not a hang', async () => {
    const client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      onNotification: () => {},
    });
    try {
      await client.request('initialize', {
        clientInfo: { name: 'cockpit-test', title: 'cockpit-test', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      });
      await expect(client.request('thread/doesNotExist', {})).rejects.toThrow();
    } finally {
      client.dispose();
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
  }, 30_000);
});
