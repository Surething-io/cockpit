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
import { AppError, NotFoundError, ValidationError } from "@cockpit/effect-core"
import {
  scheduledTaskManager,
  getNextCronTime,
  buildTaskPrompt,
  type ScheduledTask,
} from "../server/scheduledTasks"
import type { RawPatchRequest } from "../contract/scheduledTasks"

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
/**
 * Each task is returned with `resolvedPrompt` — the exact string the dispatcher
 * will send. Computing it here rather than re-deriving it in the panel keeps the
 * card honest by construction: a taskFile task's prompt wording lives in exactly
 * one place (buildTaskPrompt), so changing it can't silently leave the UI
 * advertising a message the agent never receives.
 *
 * Slash commands are still expanded later, at dispatch (resolveCommandPrompt) —
 * as they always have been for typed messages too.
 */
export const getTasksAndUnreadEff: Effect.Effect<
  {
    tasks: ReadonlyArray<ScheduledTask & { resolvedPrompt: string }>
    unreadCount: number
  },
  never
> = Effect.gen(function* () {
  const tasks = yield* getTasksEff
  const unreadCount = yield* getUnreadCountEff
  return {
    tasks: tasks.map((task) => ({
      ...task,
      resolvedPrompt: buildTaskPrompt(task),
    })),
    unreadCount,
  }
}).pipe(Effect.orElseSucceed(() => ({ tasks: [], unreadCount: 0 })))

// ─────────────────────────────────────────────────────────
// Write — CRUD
// ─────────────────────────────────────────────────────────

export const addTaskEff = (
  task: ScheduledTask
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

/** Fails NotFoundError for an unknown id, matching pause / resume / update. */
export const triggerTaskEff = (
  id: string
): Effect.Effect<void, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.triggerTask(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.triggerTask failed", cause }),
  }).pipe(
    Effect.flatMap((found) =>
      found
        ? Effect.void
        : Effect.fail(new NotFoundError({ resource: "task", id }))
    )
  )

/** Fails NotFoundError for an unknown id, matching pause / resume / update. */
export const markReadEff = (
  id: string
): Effect.Effect<void, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: () => scheduledTaskManager.markRead(id),
    catch: (cause) =>
      new AppError({ message: "scheduler.markRead failed", cause }),
  }).pipe(
    Effect.flatMap((found) =>
      found
        ? Effect.void
        : Effect.fail(new NotFoundError({ resource: "task", id }))
    )
  )

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

/** Re-exported from the wire contract so both sides share one list. */
export type { PatchAction } from "../contract/scheduledTasks"

/** Actions that name a single task and therefore require `id`. */
const TASK_SCOPED = new Set([
  "pause",
  "resume",
  "trigger",
  "markRead",
  "update",
])

/**
 * PATCH dispatcher.
 *
 * Validation lives HERE rather than in the route, because whether `id` is
 * required depends on the action. The route used to gate on `id` up front,
 * which forced id-less actions to invent a placeholder and made a missing id
 * indistinguishable from an action that never wanted one.
 *
 * Every exit is now explicit: an unrecognised action, or a recognised one whose
 * arguments are the wrong shape, fails as ValidationError (400). Nothing falls
 * through to `updateTask` any more — that fallthrough reported bad arguments as
 * "task not found", and silently merged arbitrary fields into a task whenever
 * the caller happened to pass a real id.
 */
export const dispatchPatchEff = (
  body: RawPatchRequest
): Effect.Effect<
  { task: ScheduledTask | null; simpleSuccess: boolean },
  AppError | NotFoundError | ValidationError
> => {
  const { action, fields } = body

  if (typeof action !== "string" || !action) {
    return Effect.fail(new ValidationError({ field: "action", reason: "missing" }))
  }

  // `id` is required for exactly the task-scoped actions, and meaningless for
  // the rest — so it is checked here, not before the dispatch.
  let id = ""
  if (TASK_SCOPED.has(action)) {
    if (typeof body.id !== "string" || !body.id) {
      return Effect.fail(new ValidationError({ field: "id", reason: "missing" }))
    }
    id = body.id
  }

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
  if (action === "markReadBySessionId") {
    if (typeof fields?.sessionId !== "string" || !fields.sessionId) {
      return Effect.fail(
        new ValidationError({
          field: "fields.sessionId",
          reason: "missing or not a string",
        })
      )
    }
    return markReadBySessionIdEff(fields.sessionId).pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (action === "markAllRead") {
    return markAllReadEff.pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (action === "reorder") {
    if (!Array.isArray(fields?.orderedIds)) {
      return Effect.fail(
        new ValidationError({
          field: "fields.orderedIds",
          reason: "missing or not an array",
        })
      )
    }
    return reorderTasksEff(fields.orderedIds as string[]).pipe(
      Effect.as({ task: null, simpleSuccess: true })
    )
  }
  if (action === "update") {
    if (!fields) {
      return Effect.fail(
        new ValidationError({ field: "fields", reason: "missing" })
      )
    }
    const now = Date.now()
    const updatedFields: Record<string, unknown> = { ...fields }
    // message and taskFile are mutually exclusive. updateTask merges fields onto the
    // stored task, so switching a task from one mode to the other has to blank the
    // other field explicitly — otherwise the old value survives and buildTaskPrompt,
    // which prefers taskFile, would keep dispatching a file the user just replaced
    // with a typed message.
    if ("taskFile" in fields || "message" in fields) {
      const file =
        typeof fields.taskFile === "string" ? fields.taskFile.trim() : ""
      updatedFields.taskFile = file || undefined
      updatedFields.message = file
        ? ""
        : typeof fields.message === "string"
          ? fields.message.trim()
          : ""
    }
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
  // Unrecognised action. This used to fall through to `updateTask(id, fields)`
  // (arbitrary fields merged into whatever task `id` named) when fields were
  // present, and to a 200 `{task: null}` "success" when they weren't — so a
  // typo'd action silently did nothing while telling the caller it worked.
  return Effect.fail(
    new ValidationError({ field: "action", reason: `unrecognised: ${action}` })
  )
}
