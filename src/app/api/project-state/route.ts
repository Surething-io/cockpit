/**
 * /api/project-state — P6 migration
 *
 * Project session-list CRUD (indexed by cwd).
 */
import { Effect } from "effect"
import {
  getSessionFilePath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

interface ProjectState {
  sessions: string[]
  activeSessionId?: string
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  chatModes?: Record<string, string>
  planModes?: Record<string, boolean>
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const filePath = getSessionFilePath(cwd)
    const state = yield* Effect.tryPromise({
      try: () => readJsonFile<ProjectState>(filePath, { sessions: [] }),
      catch: (cause) => new FSError({ path: filePath, op: "read", cause }),
    })
    return ok(state)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Partial<ProjectState> & {
      cwd?: string
    }
    if (!body.cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    if (!Array.isArray(body.sessions)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "sessions",
          reason: "must be array",
        })
      )
    }

    const state: ProjectState = {
      sessions: body.sessions,
      activeSessionId: body.activeSessionId,
      ...(body.engines && { engines: body.engines }),
      ...(body.ollamaModels && { ollamaModels: body.ollamaModels }),
      ...(body.deepseekModels && { deepseekModels: body.deepseekModels }),
      ...(body.chatModes && { chatModes: body.chatModes }),
      ...(body.planModes && { planModes: body.planModes }),
    }
    const filePath = getSessionFilePath(body.cwd)
    yield* Effect.tryPromise({
      try: () => writeJsonFile(filePath, state),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })
    return ok(state)
  })
)
