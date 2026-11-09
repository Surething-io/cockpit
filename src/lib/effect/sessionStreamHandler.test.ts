import { describe, expect, it, vi } from 'vitest';
import { Effect, Queue, Stream } from 'effect';
import { handleSessionStream } from './sessionStreamHandler';
import { getRunSnapshot, deleteRunRecoveryTurns, rekeyRun, appendRun, markRunIdle, releaseRun, startRun } from '@cockpit/feature-agent/server/sessionRunHub';

describe('writer settlement over the session stream', () => {
  it('delivers release during snapshot send without losing it to snapshot deduplication', async () => {
    const key = 'session-stream-snapshot-release';
    startRun(key, '/isolated-test', 'prompt', 'snapshot-release');
    markRunIdle(key, 'error');
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const output = yield* Queue.unbounded<unknown>();
      yield* Effect.forkScoped(handleSessionStream({
        send: (message) => Effect.gen(function* () {
          if ((message as { type: string }).type !== 'ping') yield* Queue.offer(output, message);
          if ((message as { type: string }).type === 'run-snapshot') yield* Effect.sync(() => releaseRun(key));
        }),
        messages: Stream.empty,
        close: Effect.void,
      }, key));
      const snapshot = yield* Queue.take(output);
      const settled = yield* Queue.take(output);
      expect(snapshot).toMatchObject({ type: 'run-snapshot', status: 'error', writerActive: true });
      expect(settled).toMatchObject({ type: 'run-event', message: { type: 'run-settled', runId: 'snapshot-release' } });
      expect((settled as { seq: number }).seq).toBeGreaterThan((snapshot as { seq: number }).seq);
    })));
    expect(getRunSnapshot(key)?.writerActive).toBe(false);
  });
});


it('sends retained failures before the successor snapshot and its live tail', async () => {
  const key = 'session-stream-recovery';
  startRun(key, '/isolated-test', 'Previous', 'previous');
  appendRun(key, { type: 'error', error: 'Failed' });
  markRunIdle(key, 'error'); releaseRun(key);
  startRun(key, '/isolated-test', 'Next', 'next');
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const output = yield* Queue.unbounded<unknown>();
    yield* Effect.forkScoped(handleSessionStream({
      send: (message) => Effect.gen(function* () {
        if ((message as { type: string }).type !== 'ping') yield* Queue.offer(output, message);
        if ((message as { type: string }).type === 'run-snapshot') yield* Effect.sync(() => appendRun(key, { type: 'assistant', message: { content: 'Late next output' } }));
      }), messages: Stream.empty, close: Effect.void,
    }, key));
    expect(yield* Queue.take(output)).toMatchObject({ type: 'run-snapshot', status: 'running', runId: 'next',
      recoveries: [{ recovery: true, runId: 'previous', writerActive: false }] });
    expect(yield* Queue.take(output)).toMatchObject({ type: 'run-event', message: { type: 'assistant', message: { content: 'Late next output' } } });
  })));
  markRunIdle(key); releaseRun(key);
});

for (const successor of [false, true]) it(`replays deletion after buffer eviction with successor=${successor}`, async () => {
  vi.useFakeTimers();
  const key = `expired-deletion-${successor}`;
  const alias = `${key}-launch`;
  try {
    startRun(alias, '/isolated-test', 'Failed', alias);
    rekeyRun(alias, key);
    markRunIdle(key, 'error'); releaseRun(key);
    vi.advanceTimersByTime(60_001);
    const deletion = { sourceIds: ['native-input'], taskIds: [] };
    deleteRunRecoveryTurns(key, deletion);
    if (successor) startRun(key, '/isolated-test', 'Next', 'successor');
    for (const target of [key, alias]) await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const output = yield* Queue.unbounded<unknown>();
      yield* Effect.forkScoped(handleSessionStream({
        send: message => Queue.offer(output, message).pipe(Effect.asVoid),
        messages: Stream.empty, close: Effect.void,
      }, target));
      expect(yield* Queue.take(output)).toMatchObject({ recoveryDeletions: [deletion] });
    })));
  } finally {
    markRunIdle(key); releaseRun(key); vi.advanceTimersByTime(60_001); vi.useRealTimers();
  }
});

it('delivers deletion during idle snapshot send after its captured deletion list', async () => {
  const key = 'idle-delete-overlap';
  const first = { sourceIds: [], taskIds: [], sourceRemap: { a: 'b' } };
  const second = { sourceIds: ['b'], taskIds: [] };
  deleteRunRecoveryTurns(key, first);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const output = yield* Queue.unbounded<unknown>();
    yield* Effect.forkScoped(handleSessionStream({
      send: message => Effect.gen(function* () {
        if ((message as { type: string }).type === 'ping') return;
        yield* Queue.offer(output, message);
        if ((message as { type: string }).type === 'run-idle') deleteRunRecoveryTurns(key, second);
      }), messages: Stream.empty, close: Effect.void,
    }, key));
    expect(yield* Queue.take(output)).toMatchObject({ type: 'run-idle', recoveryDeletions: [first] });
    expect(yield* Queue.take(output)).toMatchObject({ type: 'run-event', message: { type: 'recovery-deleted', deletion: second } });
  })));
});
