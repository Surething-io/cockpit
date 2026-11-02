// One scoped owner for input admission, FIFO delivery and atomic run closure.
import { Chunk, Effect, Option, Queue, type Scope } from 'effect';
import type { InjectedInput, RunCtx } from '../server/engines/types';

export interface PiRunInput {
  /** Called only after Pi becomes idle; an empty queue seals admission in the same tick. */
  readonly next: Effect.Effect<Option.Option<InjectedInput>>;
  /** Release ownership only after prompt, recovery and persistence have completed. */
  readonly complete: Effect.Effect<void>;
}

/** Register before SDK initialization and retain accepted input until it is consumed or failed. */
export const makePiRunInput = (
  ctx: RunCtx,
  undelivered: (inputs: InjectedInput[]) => Effect.Effect<void>,
): Effect.Effect<PiRunInput, never, Scope.Scope> => Effect.gen(function* () {
  const queue = yield* Queue.unbounded<InjectedInput>();
  let state: 'accepting' | 'closed' = 'accepting';
  let current: InjectedInput | undefined;
  const close = (): void => {
    state = 'closed';
    ctx.acceptInput(null);
  };
  yield* Effect.acquireRelease(Effect.sync(() => {
    queue.unsafeOffer({ text: ctx.prompt, images: ctx.images });
    ctx.acceptInput((input) => state === 'accepting' && !ctx.signal.aborted && queue.unsafeOffer(input));
  }), () => Effect.gen(function* () {
    yield* Effect.sync(close);
    const remaining = [...(current ? [current] : []), ...Chunk.toArray(yield* Queue.takeAll(queue))];
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
      else current = next.value;
      return next;
    }),
    complete: Effect.sync(() => { current = undefined; }),
  };
});
