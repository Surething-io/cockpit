/**
 * SchedulerLive — generic recurring task scheduler built on Effect's Schedule.
 *
 * Decoupled from the chat-specific scheduledTaskManager:
 *   - This Service provides the generic capability of "start an Effect that
 *     repeats on a Schedule".
 *   - The chat task manager is kept separate; it can adopt this Service in a
 *     later internal rewrite.
 *
 * The Live implementation uses a Scope-aware fiber map plus addFinalizer for
 * cleanup, avoiding a hand-written timers Map.
 */
import { Effect, Fiber, Layer, Ref, Schedule, Scope } from "effect"
import {
  Scheduler,
  type ScheduledTask,
} from "@cockpit/effect-services"

export const SchedulerLive = Layer.scoped(
  Scheduler,
  Effect.gen(function* () {
    // Fiber map (id -> fiber); all entries are interrupted on Scope close.
    const fibersRef = yield* Ref.make(
      new Map<string, Fiber.RuntimeFiber<unknown, unknown>>()
    )

    // Clean up all outstanding fibers on process exit
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const fibers = yield* Ref.get(fibersRef)
        for (const f of fibers.values()) {
          yield* Fiber.interrupt(f)
        }
        yield* Ref.set(fibersRef, new Map())
      })
    )

    return Scheduler.of({
      schedule: <A, E, R>(
        id: string,
        task: Effect.Effect<A, E, R>,
        policy: Schedule.Schedule<unknown, unknown>
      ): Effect.Effect<ScheduledTask<A, E>, never, R | Scope.Scope> =>
        Effect.gen(function* () {
          // Interrupt any existing fiber registered under the same id
          const existing = yield* Ref.get(fibersRef).pipe(
            Effect.map((m) => m.get(id))
          )
          if (existing) {
            yield* Fiber.interrupt(existing)
          }

          // Fork a fiber that repeats the task on the given Schedule
          const fiber = yield* Effect.forkScoped(
            task.pipe(
              Effect.repeat(policy),
              Effect.tapError((e) =>
                Effect.logError(`[scheduler] task '${id}' failed`).pipe(
                  Effect.annotateLogs("error", String(e))
                )
              )
            )
          ) as Effect.Effect<Fiber.RuntimeFiber<A, E>, never, R | Scope.Scope>

          yield* Ref.update(fibersRef, (m) =>
            new Map(m).set(id, fiber as unknown as Fiber.RuntimeFiber<unknown, unknown>)
          )

          yield* Effect.logInfo(`[scheduler] task '${id}' started`)
          return { id, fiber } satisfies ScheduledTask<A, E>
        }),

      list: Effect.gen(function* () {
        const fibers = yield* Ref.get(fibersRef)
        return Array.from(fibers.keys())
      }),

      cancel: (id) =>
        Effect.gen(function* () {
          const fibers = yield* Ref.get(fibersRef)
          const f = fibers.get(id)
          if (f) {
            yield* Fiber.interrupt(f)
            yield* Ref.update(fibersRef, (m) => {
              const next = new Map(m)
              next.delete(id)
              return next
            })
            yield* Effect.logInfo(`[scheduler] task '${id}' cancelled`)
          }
        }),
    })
  })
)
