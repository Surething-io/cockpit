/**
 * Wire contract for PATCH /api/scheduled-tasks — imported by both sides.
 *
 * TYPES ONLY. No runtime code: read by the Next route handler (server bundle)
 * and by the browser clients, and must compile away in both.
 *
 * The request is a discriminated union on `action`, which is what keeps `id`
 * honest: the three actions that don't operate on a single task have no `id`
 * field at all, so there is nothing to pass and nothing to get wrong.
 *
 * History worth keeping: the route used to gate on `id` BEFORE dispatching, so
 * id-less actions had to send a `"_"` placeholder. That convention lived only in
 * two call sites; a second client (workspace/stateClient) was written without it
 * and got a silent 400 on every call, leaving the scheduled-task unread badge
 * permanently lit. Worse, when an action's own guard failed (a non-string
 * `sessionId`, a non-array `orderedIds`, a typo'd action) the dispatcher fell
 * through to `updateTask(id, fields)` — reporting "task not found" for what was
 * really a bad-argument error, and merging the fields straight into the task
 * whenever the caller had passed a real id. Encoding the id/no-id split in the
 * type is what retires both problems.
 */

/** Actions that act on exactly one task, named by `id`. */
export type TaskScopedAction =
  | "pause"
  | "resume"
  | "trigger"
  | "markRead"
  | "update"

/** Actions that operate on the collection, or on a session — no `id`. */
export type GlobalAction = "markAllRead" | "markReadBySessionId" | "reorder"

export type PatchAction = TaskScopedAction | GlobalAction

/** `pause` | `resume` | `trigger` | `markRead` | `update` on one task. */
export interface TaskScopedPatchRequest {
  id: string
  action: TaskScopedAction
  /** Required for `update`; ignored by the rest. */
  fields?: Record<string, unknown>
}

/** Clear unread on every task belonging to one chat session. */
export interface MarkReadBySessionIdRequest {
  action: "markReadBySessionId"
  fields: { sessionId: string }
}

/** Clear unread on every task. */
export interface MarkAllReadRequest {
  action: "markAllRead"
}

/** Persist a new display order for the whole list. */
export interface ReorderRequest {
  action: "reorder"
  fields: { orderedIds: string[] }
}

export type ScheduledTaskPatchRequest =
  | TaskScopedPatchRequest
  | MarkReadBySessionIdRequest
  | MarkAllReadRequest
  | ReorderRequest

/**
 * What the SERVER receives — arbitrary JSON that has not been validated yet.
 *
 * Deliberately not `Partial<ScheduledTaskPatchRequest>`: a partial of a union is
 * still a union, which would let the handler narrow on fields it hasn't checked
 * and pretend a hostile body is one of the four legal shapes. The dispatcher
 * validates this into one of the shapes above and rejects everything else.
 */
export interface RawPatchRequest {
  id?: unknown
  action?: unknown
  fields?: Record<string, unknown>
}
