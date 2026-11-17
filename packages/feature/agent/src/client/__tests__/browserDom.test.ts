import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { captureBrowserDom } from './browserDom';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function pendingBrowser() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  vi.mocked(readFile).mockImplementation(() => new Promise(() => {}));
  return child;
}

describe('browser capture lifetime', () => {
  it('cancels a timed-out test and waits for browser cleanup before rejecting', async () => {
    const child = pendingBrowser();
    const controller = new AbortController();
    const aborted = new Error('Test timed out');
    const capture = captureBrowserDom('chrome', '/fixture', undefined, controller.signal);
    let settled = false;
    const checked = expect(capture).rejects.toBe(aborted).then(() => { settled = true; });

    controller.abort(aborted);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith());
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await checked;
  });

  it('bounds stalled startup IO and escalates a browser that ignores termination', async () => {
    vi.useFakeTimers();
    const child = pendingBrowser();
    const capture = captureBrowserDom('chrome', '/fixture');
    const checked = expect(capture).rejects.toThrow('Browser capture timed out');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(child.kill).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });
});
