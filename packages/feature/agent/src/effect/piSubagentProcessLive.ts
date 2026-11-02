// One Effect owner closes a child on protocol failure, cancellation or completion.
import { Effect, Fiber, Option } from 'effect';
import type { AgentError } from '@cockpit/effect-core';
import type { PiChildProcess, PiChildResult } from '../server/engines/shared/piSubagentProcess';

export const runPiChildProcess = (
  acquire: Effect.Effect<PiChildProcess, AgentError>,
  afterClose: (result: PiChildResult) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<PiChildResult, AgentError> => Effect.acquireUseRelease(
  acquire,
  (child) => Effect.raceFirst(
    Effect.promise(() => child.closed),
    Effect.promise(() => child.failed),
  ).pipe(Effect.as(child)),
  (child) => Effect.gen(function* () {
    // Release must survive the caller's interrupt, but the timeout must be able
    // to interrupt its wait. Run only that wait in a fresh interruptible fiber;
    // join it here, then still await actual close before releasing resources.
    const wait = Effect.promise(() => child.closed).pipe(
      Effect.timeoutOption('3 seconds'), Effect.interruptible,
      Effect.forkDaemon, Effect.flatMap(Fiber.join),
    );
    if (!child.isClosed()) {
      yield* Effect.sync(child.cancel);
      const exited = yield* wait;
      if (Option.isNone(exited)) {
        yield* Effect.sync(child.terminate);
        const terminated = yield* wait;
        if (Option.isNone(terminated)) {
          yield* Effect.sync(child.kill);
          yield* Effect.promise(() => child.closed);
        }
      }
    }
    yield* afterClose(yield* Effect.promise(() => child.closed));
  }),
).pipe(Effect.flatMap((child) => Effect.promise(() => child.closed)));
