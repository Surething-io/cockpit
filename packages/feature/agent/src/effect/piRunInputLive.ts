// One scoped owner for input admission, FIFO delivery and atomic run closure.
import { Chunk, Effect, Option, Queue, type Scope } from 'effect';
import type { InjectedInput, RunCtx } from '../server/engines/types';

export interface PiRunInput {
  /** Called only after Pi becomes idle; an empty queue seals admission in the same tick. */
  readonly next: Effect.Effect<Option.Option<InjectedInput>>;
  /** Release ownership only after prompt, recovery and persistence have completed. */
  readonly complete: Effect.Effect<void>;
  /** Pi persisted this input natively; a Stop no longer makes it recovery material. */
  readonly delivered: (inputId: string) => Effect.Effect<void>;
}

/** Register before SDK initialization and retain accepted input until it is consumed or failed. */
export const makePiRunInput = (
  ctx: RunCtx,
  undelivered: (inputs: InjectedInput[]) => Effect.Effect<void>,
): Effect.Effect<PiRunInput, never, Scope.Scope> => Effect.gen(function* () {
  const queue = yield* Queue.unbounded<InjectedInput>();
  let state: 'accepting' | 'closed' = 'accepting';
  let current: InjectedInput | undefined;
  let currentDelivered = false;
  const close = (): void => {
    state = 'closed';
    ctx.acceptInput(null);
  };
  yield* Effect.acquireRelease(Effect.sync(() => {
    queue.unsafeOffer({ text: ctx.prompt, images: ctx.images, inputId: ctx.params.runId });
    ctx.acceptInput((input) => state === 'accepting' && !ctx.signal.aborted && queue.unsafeOffer(input));
  }), () => Effect.gen(function* () {
    yield* Effect.sync(close);
    // A cancelled run keeps the native record of a delivered input; a failed run
    // cannot confirm that input completed, so it stays recoverable.
    const keepCurrent = current && !(ctx.signal.aborted && currentDelivered);
    const remaining = [...(keepCurrent ? [current!] : []), ...Chunk.toArray(yield* Queue.takeAll(queue))];
    if (remaining.length) yield* undelivered(remaining);
    yield* Queue.shutdown(queue);
  }));
  return {
    next: Effect.sync(() => {
      if (ctx.signal.aborted || state === 'closed') {
        close();
        return Option.none();
      }
      // This private queue has no competing consumer. poll never suspends; runSync
      // keeps the empty check and seal in one JS tick, with no admission gap.
      const next = Effect.runSync(Queue.poll(queue));
      if (Option.isNone(next)) close();
      else { current = next.value; currentDelivered = false; }
      return next;
    }),
    complete: Effect.sync(() => { current = undefined; currentDelivered = false; }),
    delivered: (inputId) => Effect.sync(() => { if (current?.inputId === inputId) currentDelivered = true; }),
  };
});
