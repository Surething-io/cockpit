import { afterEach, describe, expect, it, vi } from 'vitest';
import { coEditFromGit } from './coedit';

const git = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = Object.defineProperty(vi.fn(), promisify.custom, { value: git });
  return { execFile };
});

function deferredOutput() {
  let resolve!: (output: { stdout: string; stderr: string }) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<{ stdout: string; stderr: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  git.mockReset();
});

describe('coedit Git process lifetime', () => {
  it.each(['log', 'status'] as const)('waits for the other command when %s fails', async (command) => {
    vi.useFakeTimers();
    const history = deferredOutput();
    const status = deferredOutput();
    git.mockImplementation((_file: string, args: string[]) => {
      if (args.includes('log')) return history.promise;
      if (args.includes('status')) return status.promise;
      // A valid HEAD ensures a failed log is not treated as an unborn branch.
      return Promise.resolve({ stdout: 'HEAD', stderr: '' });
    });

    const fulfilled = vi.fn();
    const rejected = vi.fn();
    const lookup = coEditFromGit('/fixture', 'core.ts').then(fulfilled, rejected);
    await vi.runAllTimersAsync();
    expect(git).toHaveBeenCalledTimes(2);

    const cause = Object.assign(new Error('Git failed'), { code: 42 });
    const failed = command === 'log' ? history : status;
    const sibling = command === 'log' ? status : history;
    failed.reject(cause);
    await vi.runAllTimersAsync();
    expect(fulfilled).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    sibling.resolve({ stdout: '', stderr: '' });
    await vi.runAllTimersAsync();
    await lookup;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ _tag: 'AppError', cause }));
  });
});
