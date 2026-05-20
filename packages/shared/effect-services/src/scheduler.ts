/**
 * Scheduler — unified abstraction for cron / recurring tasks.
 *
 * Replaces packages/feature/agent/src/server/scheduledTasks.ts and the
 * scattered setTimeout/setInterval call sites.
 */
import { Context, Effect, Fiber, Schedule, Scope } from "effect"

export interface ScheduledTask<A, E> {
  readonly id: string
  readonly fiber: Fiber.RuntimeFiber<A, E>
}

export interface Scheduler {
  /**
   * Start a task that repeats according to the given Schedule; interrupted
   * automatically when the Scope closes.
   */
  readonly schedule: <A, E, R>(
    id: string,
    task: Effect.Effect<A, E, R>,
    policy: Schedule.Schedule<unknown, unknown>
  ) => Effect.Effect<ScheduledTask<A, E>, never, R | Scope.Scope>

  /** List all currently scheduled tasks. */
  readonly list: Effect.Effect<ReadonlyArray<string>>

  /** Cancel a task by id. */
  readonly cancel: (id: string) => Effect.Effect<void>
}

export const Scheduler = Context.GenericTag<Scheduler>("@cockpit/Scheduler")
