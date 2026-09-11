import { describe, expect, it } from 'vitest';
import { createLatestTaskRunner } from './latestTaskRunner';

describe('createLatestTaskRunner', () => {
  it('keeps the running task and coalesces pending values to the latest', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runner = createLatestTaskRunner(async (value: string) => {
      events.push(`${value}:start`);
      if (value === 'A') await firstDone;
      events.push(`${value}:end`);
    });

    runner.enqueue('A');
    runner.enqueue('B');
    runner.enqueue('C');
    expect(events).toEqual(['A:start']);

    releaseFirst();
    await runner.whenIdle();
    expect(events).toEqual(['A:start', 'A:end', 'C:start', 'C:end']);
  });

  it('continues with the latest value after a failure', async () => {
    const events: string[] = [];
    const runner = createLatestTaskRunner(async (value: string) => {
      events.push(value);
      if (value === 'A') throw new Error('failed');
    });

    runner.enqueue('A');
    runner.enqueue('B');
    await runner.whenIdle();
    expect(events).toEqual(['A', 'B']);
  });
});
