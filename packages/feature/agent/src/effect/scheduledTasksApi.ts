/**
 * scheduledTasksApi.ts — Effect facade over the ScheduledTaskManager singleton.
 *
 * Wraps the manager's 11 public methods as Effects, mapping errors uniformly
 * to AppError / NotFoundError. Route handlers and WS subscribers no longer need
 * their own `Effect.tryPromise({try, catch})` boilerplate.
 *
 * The manager's internal setTimeout / Map<id, Timeout> scheduling is left
 * untouched (BACKLOG): replacing the timer with a SchedulerLive Fiber requires
 * a separate pass and involves HMR / dual-instance / reentrancy pitfalls.
 */
import { Effect } from "effect"
import { AppError, NotFoundError } from "@cockpit/effect-core"
import {
  scheduledTaskManager,
  getNextCronTime,
  type ScheduledTask,
} from "../server/scheduledTasks"

// ─────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────

export const getTasksEff: Effect.Effect<
  ReadonlyArray<ScheduledTask>,
  AppError
> = Effect.tryPromise({
  try: () => scheduledTaskManager.getTasks(),
  catch: (cause) =>
    new AppError({ message: "scheduler.getTasks failed", cause }),
})

export const getUnreadCountEff: Effect.Effect<number, AppError> =
  Effect.tryPromise({
    try: () => scheduledTaskManager.getUnreadCount(),
    catch: (cause) =>
      new AppError({ message: "scheduler.getUnreadCount failed", cause }),
  })

/** Combined GET list + unread count; on failure falls back to an empty result. */
export const getTasksAndUnreadEff: Effect.Effect<
  { tasks: ReadonlyArray<ScheduledTask>; unreadCount: number },
  never
> = Effect.gen(function* () {
  const tasks = yield* getTasksEff
  const unreadCount = yield* getUnreadCountEff
  return { tasks, unreadCount }
}).pipe(Effect.orElseSucceed(() => ({ tasks: [], unreadCount: 0 })))

// ─────────────────────────────────────────────────────────
// Write — CRUD
// ─────────────────────────────────────────────────────────

export const addTaskEff = (
  task: Omit<ScheduledTask, "port">
): Effect.Effect<ScheduledTask, AppError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.addTask(task),
    catch: (cause) =>
      new AppError({ message: "scheduler.addTask failed", cause }),
  })

/** updateTask: throws AppError on failure; throws NotFoundError when the task is not found. */
export const updateTaskEff = (
  id: string,
  fields: Partial<ScheduledTask>
): Effect.Effect<ScheduledTask, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.updateTask(id, fields),
    catch: (cause) =>
      new AppError({ message: "scheduler.updateTask failed", cause }),
  }).pipe(
    Effect.flatMap((task) =>
      task
        ? Effect.succeed(task)
        : Effect.fail(new NotFoundError({ resource: "task", id }))
    )
  )

export const deleteTaskEff = (
  id: string
): Effect.Effect<void, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.deleteTask(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.deleteTask failed", cause }),
  }).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.fail(new NotFoundError({ resource: "task", id }))
    )
  )

// ─────────────────────────────────────────────────────────
// Lifecycle actions
// ─────────────────────────────────────────────────────────

export const pauseTaskEff = (
  id: string
): Effect.Effect<ScheduledTask, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.pauseTask(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.pauseTask failed", cause }),
  }).pipe(
    Effect.flatMap((task) =>
      task
        ? Effect.succeed(task)
        : Effect.fail(new NotFoundError({ resource: "task", id }))
    )
  )

export const resumeTaskEff = (
  id: string
): Effect.Effect<ScheduledTask, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.resumeTask(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.resumeTask failed", cause }),
  }).pipe(
    Effect.flatMap((task) =>
      task
        ? Effect.succeed(task)
        : Effect.fail(new NotFoundError({ resource: "task", id }))
    )
  )

export const triggerTaskEff = (id: string): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.triggerTask(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.triggerTask failed", cause }),
  })

export const markReadEff = (id: string): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.markRead(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.markRead failed", cause }),
  })

export const markReadBySessionIdEff = (
  sessionId: string
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.markReadBySessionId(sessionId),
    catch: (cause) =>
      new AppError({ message: "scheduler.markReadBySessionId failed", cause }),
  })

export const markAllReadEff: Effect.Effect<void, AppError> = Effect.tryPromise({
  try: () => scheduledTaskManager.markAllRead(),
  catch: (cause) =>
    new AppError({ message: "scheduler.markAllRead failed", cause }),
})

export const reorderTasksEff = (
  orderedIds: ReadonlyArray<string>
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.reorderTasks([...orderedIds]),
    catch: (cause) =>
      new AppError({ message: "scheduler.reorderTasks failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// PATCH action dispatcher: collapses the ~80-line if/else chain from the route handler
// ─────────────────────────────────────────────────────────

export type PatchAction =
  | "pause"
  | "resume"
  | "trigger"
  | "markRead"
  | "markReadBySessionId"
  | "markAllRead"
  | "reorder"
  | "update"

/**
 * PATCH dispatcher:
 * - pause / resume -> returns the updated task
 * - trigger / markRead / markReadBySessionId / markAllRead / reorder -> simpleSuccess
 * - update -> recomputes nextFireTime (once/interval/cron) then calls updateTask
 * - When no recognised action is provided, fields are passed straight through to updateTask
 */
export const dispatchPatchEff = (
  id: string,
  action: PatchAction | string | undefined,
  fields?: Record<string, unknown>
): Effect.Effect<
  { task: ScheduledTask | null; simpleSuccess: boolean },
  AppError | NotFoundError
> => {
  if (action === "pause") {
    return pauseTaskEff(id).pipe(
      Effect.map((task) => ({ task, simpleSuccess: false }))
    )
  }
  if (action === "resume") {
    return resumeTaskEff(id).pipe(
      Effect.map((task) => ({ task, simpleSuccess: false }))
    )
  }
  if (action === "trigger") {
    return triggerTaskEff(id).pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (action === "markRead") {
    return markReadEff(id).pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (
    action === "markReadBySessionId" &&
    typeof fields?.sessionId === "string"
  ) {
    return markReadBySessionIdEff(fields.sessionId).pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (action === "markAllRead") {
    return markAllReadEff.pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (
    action === "reorder" &&
    Array.isArray(fields?.orderedIds)
  ) {
    return reorderTasksEff(fields.orderedIds as string[]).pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (action === "update" && fields) {
    const now = Date.now()
    const updatedFields: Record<string, unknown> = { ...fields }
    if (fields.type === "once" && fields.delayMinutes) {
      updatedFields.nextFireTime =
        now + (fields.delayMinutes as number) * 60000
      updatedFields.completed = false
    } else if (fields.type === "interval" && fields.intervalMinutes) {
      updatedFields.nextFireTime =
        now + (fields.intervalMinutes as number) * 60000
    } else if (fields.type === "cron" && fields.cron) {
      updatedFields.nextFireTime = getNextCronTime(fields.cron as string)
    }
    updatedFields.paused = false
    return updateTaskEff(id, updatedFields).pipe(
      Effect.map((task) => ({ task, simpleSuccess: false }))
    )
  }
  if (fields) {
    return updateTaskEff(id, fields).pipe(
      Effect.map((task) => ({ task, simpleSuccess: false }))
    )
  }
  return Effect.succeed({ task: null, simpleSuccess: false })
}
