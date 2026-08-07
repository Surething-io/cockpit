/**
 * /api/scheduled-tasks — P8+ migration (GET/POST/PATCH/DELETE)
 *
 * P8+ follow-up: the ~80 lines of Effect.tryPromise + if/else dispatch inside
 * the route handler are replaced by calls to the Effect facade in
 * `effect/scheduledTasksApi.ts`; the handler body now only does body parsing,
 * field validation, and the ok() exit.
 */
import { existsSync } from "fs"
import { Effect } from "effect"
import { getNextCronTime, type ScheduledTask } from "../scheduledTasks"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import {
  getTasksAndUnreadEff,
  addTaskEff,
  deleteTaskEff,
  dispatchPatchEff,
} from "../../effect/scheduledTasksApi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Engines sendChatMessageEff knows how to dispatch — keep in sync with the allowlist there. */
const SCHEDULABLE_ENGINES = [
  "claude",
  "ollama",
  "codex",
  "kimi",
  "deepseek",
  "glm",
]

/**
 * Engines whose chat route accepts a `model` param, so snapshotting the picker's choice on
 * the task means something. The others resolve their model themselves (claude from
 * the CLI config, codex from its own settings) and would silently ignore the field.
 */
const MODEL_AWARE_ENGINES = new Set(["ollama", "deepseek", "kimi", "glm"])

/**
 * A task carries its instruction EITHER inline (`message`) OR by reference
 * (`taskFile`, an absolute path the agent reads at fire time) — never both, so
 * neither the panel nor the dispatcher has to guess which one wins.
 *
 * The taskFile is checked for existence here rather than only at fire time so a
 * typo'd path fails while the user is still looking at the dialog. Existence is
 * re-checked before every dispatch too (sendChatMessageEff): the file can be moved
 * or deleted long after the task was created. No extension check — a task
 * description in .txt or with no suffix is just as valid as one in .md.
 */
const validateTaskSourceEff = (
  message: string | undefined,
  taskFile: string | undefined
): Effect.Effect<{ message: string; taskFile?: string }, ValidationError> =>
  Effect.gen(function* () {
    const msg = message?.trim() ?? ""
    const file = taskFile?.trim() ?? ""
    if (!msg && !file) {
      return yield* Effect.fail(
        new ValidationError({ field: "message|taskFile", reason: "missing" })
      )
    }
    if (!file) return { message: msg }
    if (!file.startsWith("/")) {
      return yield* Effect.fail(
        new ValidationError({ field: "taskFile", reason: "must be absolute" })
      )
    }
    if (!existsSync(file)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "taskFile",
          reason: "File does not exist or cannot be read",
        })
      )
    }
    // taskFile wins outright: message is blanked so no stale text lingers behind it.
    return { message: "", taskFile: file }
  })

export const GET = handler(() =>
  Effect.gen(function* () {
    const result = yield* getTasksAndUnreadEff
    return ok(result)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      tabId?: string
      sessionId?: string
      engine?: string
      model?: string
      language?: string
      message?: string
      taskFile?: string
      type?: "once" | "interval" | "cron"
      delayMinutes?: number
      intervalMinutes?: number
      activeFrom?: string
      activeTo?: string
      cron?: string
    }
    const {
      cwd,
      tabId,
      sessionId,
      engine,
      model,
      language,
      message,
      taskFile,
      type,
      delayMinutes,
      intervalMinutes,
      activeFrom,
      activeTo,
      cron,
    } = body
    if (!cwd || !tabId || !sessionId || !type) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|tabId|sessionId|type",
          reason: "missing",
        })
      )
    }
    // message and taskFile are mutually exclusive: exactly one carries the task.
    const validated = yield* validateTaskSourceEff(message, taskFile)
    // Safety net: engine must be one sendChatMessageEff knows how to dispatch
    // (all current ChatEngine values; rejects only unknown/future ids).
    if (engine && !SCHEDULABLE_ENGINES.includes(engine)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "engine",
          reason: `unknown engine '${engine}'`,
        })
      )
    }

    const now = Date.now()
    let nextFireTime: number
    if (type === "once" && delayMinutes) {
      nextFireTime = now + delayMinutes * 60000
    } else if (type === "interval" && intervalMinutes) {
      nextFireTime = now + intervalMinutes * 60000
    } else if (type === "cron" && cron) {
      nextFireTime = getNextCronTime(cron)
    } else {
      return yield* Effect.fail(
        new ValidationError({
          field: "type|timeConfig",
          reason: "Invalid type or missing time config",
        })
      )
    }

    const task: Omit<ScheduledTask, "port"> = {
      id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      cwd,
      tabId,
      sessionId,
      engine,
      // model snapshot only matters for engines whose chat route accepts it
      model: engine && MODEL_AWARE_ENGINES.has(engine) ? model : undefined,
      language,
      message: validated.message,
      taskFile: validated.taskFile,
      type,
      delayMinutes: type === "once" ? delayMinutes : undefined,
      intervalMinutes: type === "interval" ? intervalMinutes : undefined,
      activeFrom: type === "interval" ? activeFrom : undefined,
      activeTo: type === "interval" ? activeTo : undefined,
      cron: type === "cron" ? cron : undefined,
      nextFireTime,
      paused: false,
      createdAt: now,
    }
    const created = yield* addTaskEff(task)
    return ok({ task: created })
  })
)

export const PATCH = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      id?: string
      action?: string
      fields?: Record<string, unknown>
    }
    const { id, action, fields } = body
    if (!id) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }
    const result = yield* dispatchPatchEff(id, action, fields)
    if (result.simpleSuccess) return ok({ success: true })
    return ok({ task: result.task })
  })
)

export const DELETE = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { id?: string }
    if (!body.id) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }
    yield* deleteTaskEff(body.id)
    return ok({ success: true })
  })
)
