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
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

interface ProjectState {
  sessions: string[]
  activeSessionId?: string
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  kimiModels?: Record<string, string>
  glmModels?: Record<string, string>
  chatModes?: Record<string, string>
  planModes?: Record<string, boolean>
  noHistories?: Record<string, boolean>
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
      closedSessionIds?: string[]
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

    const cwd = body.cwd
    const incoming = body.sessions
    const closedIds = body.closedSessionIds ?? []
    const filePath = getSessionFilePath(cwd)

    // Read-modify-write under a lock: UNION the incoming sessions with what's already
    // persisted, then subtract explicitly-closed ids. A browser tab only knows ITS OWN open
    // subset; a plain overwrite would let a tab with fewer tabs shrink the shared set and
    // collapse the others (the "not opened here" == "closed" bug). Union makes those
    // distinct — removal happens ONLY via closedSessionIds.
    const state = yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const existing = await readJsonFile<ProjectState>(filePath, { sessions: [] })
          const closed = new Set(closedIds)
          const union: string[] = []
          for (const sid of [...existing.sessions, ...incoming]) {
            if (!closed.has(sid) && !union.includes(sid)) union.push(sid)
          }
          const inSet = new Set(union)
          /**
           * How a session was configured OUTLIVES its tab. These maps used to be pruned to the
           * open-tab set, which made closing a tab silently reset the session: reopening it
           * from a session list came back with the default engine / execution mode / model /
           * toggles. Engine and deepseek's sdk-vs-builtin can be re-derived from which store
           * holds the transcript (so that case self-corrected after a round-trip, visibly
           * flickering); claude's pty-vs-sdk, the ollama/deepseek model and the two toggles
           * can NOT be derived from anywhere — those were simply lost.
           *
           * Kept instead of pruned, and bounded by dropping the DEFAULT rather than by tab
           * lifetime: a missing key already means "the default", so recording it buys nothing.
           * That keeps a claude-only project's maps as empty as they are today, while the
           * sessions that actually differ from the default — the only ones a reset would be
           * noticeable on — are the ones that occupy a slot.
           */
          const carryOver = <T>(
            a: Record<string, T> | undefined,
            b: Record<string, T> | undefined,
            isDefault?: (v: T) => boolean
          ) => {
            const m: Record<string, T> = { ...(a ?? {}), ...(b ?? {}) }
            for (const id of Object.keys(m)) {
              if (m[id] === undefined || isDefault?.(m[id])) delete m[id]
            }
            return m
          }
          const engines = carryOver(existing.engines, body.engines, (v) => v === "claude")
          const ollamaModels = carryOver(existing.ollamaModels, body.ollamaModels)
          const deepseekModels = carryOver(existing.deepseekModels, body.deepseekModels)
          const kimiModels = carryOver(existing.kimiModels, body.kimiModels)
          const glmModels = carryOver(existing.glmModels, body.glmModels)
          const chatModes = carryOver(existing.chatModes, body.chatModes, (v) => v === "sdk")
          const planModes = carryOver(existing.planModes, body.planModes, (v) => !v)
          const noHistories = carryOver(existing.noHistories, body.noHistories, (v) => !v)
          const active = body.activeSessionId ?? existing.activeSessionId
          const next: ProjectState = {
            sessions: union,
            ...(active && inSet.has(active) ? { activeSessionId: active } : {}),
            ...(Object.keys(engines).length ? { engines } : {}),
            ...(Object.keys(ollamaModels).length ? { ollamaModels } : {}),
            ...(Object.keys(deepseekModels).length ? { deepseekModels } : {}),
            ...(Object.keys(kimiModels).length ? { kimiModels } : {}),
            ...(Object.keys(glmModels).length ? { glmModels } : {}),
            ...(Object.keys(chatModes).length ? { chatModes } : {}),
            ...(Object.keys(planModes).length ? { planModes } : {}),
            ...(Object.keys(noHistories).length ? { noHistories } : {}),
          }
          await writeJsonFile(filePath, next)
          return next
        }),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })

    // #10: notify other browser tabs to reconcile in-app tabs. closedSessionIds carries the
    // precise removals so viewers remove exactly those tabs (never collapse by set diff).
    yield* Effect.sync(() =>
      broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: closedIds })
    )
    return ok(state)
  })
)
