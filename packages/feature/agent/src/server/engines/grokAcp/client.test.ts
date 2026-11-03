import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { GrokAcpClient } from './client';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  spawn.mockReset();
});
function fixture() {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const killer = new EventEmitter();
  spawn.mockReturnValueOnce(child).mockReturnValue(killer);
  const client = new GrokAcpClient({ binary: 'mock-grok', cwd: '.', env: { NODE_ENV: 'test' },
    onNotification: vi.fn(), onRequest: () => ({}), onClosed: vi.fn(),
  });
  return { client, child, killer };
}

describe('Grok ACP Windows teardown', () => {
  it.each([false, true])('forces the entire console process tree to exit (force=%s)', async (force) => {
    const { client, child } = fixture();
    client.dispose(force);
    expect(spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '12345', '/T', '/F'], expect.objectContaining({ stdio: 'ignore' }));
    let exited = false;
    void client.exited.then(() => { exited = true; });
    await Promise.resolve();
    expect(exited).toBe(false);
    child.emit('exit', 1, null);
    await client.exited;
    expect(exited).toBe(true);
  });

  it.each(['spawn-error', 'nonzero-exit'])('falls back to terminating the child after taskkill %s', (failure) => {
    const { client, child, killer } = fixture();
    client.dispose();
    if (failure === 'spawn-error') killer.emit('error', new Error('taskkill unavailable'));
    else killer.emit('exit', 1);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('exit', 1, null);
  });

  it('does not launch taskkill for an already exited child', async () => {
    const { client, child } = fixture();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await client.exited;
    client.dispose();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
