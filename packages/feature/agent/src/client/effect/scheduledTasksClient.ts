/**
 * Client-side scheduled tasks IO — Effect wrappers
 *
 * Wraps the 10 fetch call sites in useScheduledTasks, collapsing 4 verbs + 8 PATCH actions
 * into 4 wrappers: loadScheduledTasks / createScheduledTask / patchScheduledTask /
 * deleteScheduledTask.
 *
 * Complements stateClient.ts (PATCH markRead by sessionId) on the same endpoint: the latter
 * handles session-level cleanup, while this file handles per-task CRUD.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type {
  PatchAction,
  ScheduledTaskPatchRequest,
} from "../../contract/scheduledTasks"

const httpGet = <A>(url: string): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `fetch ${url} failed`, cause }),
  })

const httpJson = <A>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `${method} ${url} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// Types (shared with the hook, though the hook keeps ScheduledTask local)
// ─────────────────────────────────────────────────────────

export interface ScheduledTasksListResponse<T> {
  tasks?: ReadonlyArray<T>
  unreadCount?: number
}

export interface CreateScheduledTaskParams {
  cwd: string
  tabId: string
  sessionId: string
  message: string
  type: "once" | "interval" | "cron"
  delayMinutes?: number
  intervalMinutes?: number
  activeFrom?: string
  activeTo?: string
  cron?: string
}

/**
 * Every PATCH action the route dispatches, sourced from the wire contract so
 * this list cannot drift from the server's. (The hand-maintained version this
 * replaces was missing `markReadBySessionId`, because that one action was
 * reached through a second, separately-written client.)
 */
export type ScheduledTaskAction = PatchAction

// ─────────────────────────────────────────────────────────
// API client functions
// ─────────────────────────────────────────────────────────

/**
 * Fetch the scheduled-task list plus unread count.
 */
export const loadScheduledTasks = <T>(): Effect.Effect<
  ScheduledTasksListResponse<T>,
  AppError
> => httpGet<ScheduledTasksListResponse<T>>("/api/scheduled-tasks")

/**
 * Create a scheduled task; returns the `{ task }` wrapper shape.
 */
export const createScheduledTask = <T>(
  params: CreateScheduledTaskParams
): Effect.Effect<{ task?: T }, AppError> =>
  httpJson<{ task?: T }>("/api/scheduled-tasks", "POST", params)

/**
 * Unified PATCH entry.
 *
 * Takes the whole request object rather than positional (id, action, fields):
 * the contract is a discriminated union on `action`, so the three collection-
 * level actions have no `id` to pass and the compiler enforces the split. The
 * old signature forced every caller to supply an id, which is why the id-less
 * ones invented a `"_"` placeholder.
 */
export const patchScheduledTask = (
  body: ScheduledTaskPatchRequest
): Effect.Effect<void, AppError> =>
  httpJson<unknown>("/api/scheduled-tasks", "PATCH", body).pipe(Effect.asVoid)

/**
 * Delete a scheduled task.
 */
export const deleteScheduledTask = (
  id: string
): Effect.Effect<void, AppError> =>
  httpJson<unknown>("/api/scheduled-tasks", "DELETE", { id }).pipe(
    Effect.asVoid
  )
