/**
 * /api/scheduled-tasks — P8+ migration (GET/POST/PATCH/DELETE)
 *
 * P8+ follow-up: the ~80 lines of Effect.tryPromise + if/else dispatch inside
 * the route handler are replaced by calls to the Effect facade in
 * `effect/scheduledTasksApi.ts`; the handler body now only does body parsing,
 * field validation, and the ok() exit.
 */
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
      message?: string
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
      message,
      type,
      delayMinutes,
      intervalMinutes,
      activeFrom,
      activeTo,
      cron,
    } = body
    if (!cwd || !tabId || !sessionId || !message || !type) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|tabId|sessionId|message|type",
          reason: "missing",
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
      message,
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
