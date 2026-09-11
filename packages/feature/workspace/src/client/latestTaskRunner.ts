export interface LatestTaskRunner<T> {
  /** Start immediately when idle; otherwise replace the one waiting task. */
  enqueue(value: T): void;
  /** Resolves after the running task and the latest queued task have finished. */
  whenIdle(): Promise<void>;
}

/**
 * Run at most one task at a time while coalescing pending values to the latest.
 * This preserves write ordering without building an unbounded queue of stale
 * UI snapshots during chat initialization.
 */
export function createLatestTaskRunner<T>(
  run: (value: T) => Promise<void>,
): LatestTaskRunner<T> {
  let running = false;
  let pending: T | undefined;
  let idle = Promise.resolve();

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending !== undefined) {
        const next = pending;
        pending = undefined;
        try {
          await run(next);
        } catch {
          // A failed snapshot must not prevent the latest one from being saved.
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    enqueue(value) {
      pending = value;
      if (!running) idle = drain();
    },
    whenIdle() {
      return idle;
    },
  };
}
