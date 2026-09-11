/**
 * /api/project-state — P6 migration
 *
 * Project session-list CRUD (indexed by cwd).
 */
import { Effect } from "effect"
import {
  getSessionFilePath,
  normalizeCodexSessionId,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

interface ProjectState {
  sessions: string[]
  /** `null` means the active tab is a blank New Chat. */
  activeSessionId?: string | null
  /** Pane layout, by session, in on-screen order. `null` = a pane whose chat has
   *  no session yet. Length < 2 is single-pane and is not stored. */
  paneSessionIds?: (string | null)[]
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  kimiModels?: Record<string, string>
  glmModels?: Record<string, string>
  claudeModels?: Record<string, string>
  claudeEfforts?: Record<string, string>
  claudeContextWindows?: Record<string, string>
  claudeFastModes?: Record<string, boolean>
  claudeThinkings?: Record<string, boolean>
  codexModels?: Record<string, string>
  codexReasoningEfforts?: Record<string, string>
  planModes?: Record<string, boolean>
  noHistories?: Record<string, boolean>
}

function normalizeCodexEngineMap(engines?: Record<string, string>): Record<string, string> | undefined {
  if (!engines) return undefined
  const out: Record<string, string> = {}
  for (const [sid, engine] of Object.entries(engines)) {
    out[engine === "codex" ? normalizeCodexSessionId(sid) : sid] = engine
  }
  return out
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
          const existingEngines = normalizeCodexEngineMap(existing.engines)
          const incomingEngines = normalizeCodexEngineMap(body.engines)
          const normalizeSessionId = (sid: string) => {
            const normalized = normalizeCodexSessionId(sid)
            if (normalized === sid) return sid
            return existing.engines?.[sid] === "codex" || body.engines?.[sid] === "codex"
              ? normalized
              : sid
          }
          const closed = new Set(closedIds.map(normalizeSessionId))
          const union: string[] = []
          for (const rawSid of [...existing.sessions, ...incoming]) {
            const sid = normalizeSessionId(rawSid)
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
          const engines = carryOver(existingEngines, incomingEngines, (v) => v === "claude")
          const ollamaModels = carryOver(existing.ollamaModels, body.ollamaModels)
          const deepseekModels = carryOver(existing.deepseekModels, body.deepseekModels)
          const kimiModels = carryOver(existing.kimiModels, body.kimiModels)
          const glmModels = carryOver(existing.glmModels, body.glmModels)
          const claudeModels = carryOver(existing.claudeModels, body.claudeModels)
          const claudeEfforts = carryOver(existing.claudeEfforts, body.claudeEfforts)
          const claudeContextWindows = carryOver(existing.claudeContextWindows, body.claudeContextWindows)
          const claudeFastModes = carryOver(existing.claudeFastModes, body.claudeFastModes, (v) => !v)
          const claudeThinkings = carryOver(existing.claudeThinkings, body.claudeThinkings, (v) => !v)
          const codexModels = carryOver(existing.codexModels, body.codexModels)
          const codexReasoningEfforts = carryOver(existing.codexReasoningEfforts, body.codexReasoningEfforts)
          const planModes = carryOver(existing.planModes, body.planModes, (v) => !v)
          const noHistories = carryOver(existing.noHistories, body.noHistories, (v) => !v)
          // `null` is intentional state, not an omitted value: it records that the
          // selected tab is a blank New Chat. Using `?? existing.activeSessionId`
          // here used to resurrect the previous session on refresh.
          const activeRaw = Object.prototype.hasOwnProperty.call(body, "activeSessionId")
            ? body.activeSessionId
            : existing.activeSessionId
          const active = typeof activeRaw === "string" && activeRaw
            ? normalizeSessionId(activeRaw)
            : null
          /**
           * Pane layout is last-writer-wins like activeSessionId, NOT unioned:
           * it describes one browser tab's screen, and there is no meaningful
           * union of two different layouts.
           *
           * An id that is no longer in the set becomes `null` rather than
           * dropping the entry — a session closed in another browser tab should
           * leave that pane blank, not silently collapse a two-pane layout to
           * one. The client always sends the array (length 1 when single), so
           * omitting it here is how "split turned off" gets persisted.
           */
          const panesIn = body.paneSessionIds ?? existing.paneSessionIds
          const panes = Array.isArray(panesIn)
            ? panesIn.map((sid) => {
                if (typeof sid !== "string" || !sid) return null
                const n = normalizeSessionId(sid)
                return inSet.has(n) ? n : null
              })
            : undefined
          const next: ProjectState = {
            sessions: union,
            ...(active && inSet.has(active)
              ? { activeSessionId: active }
              : active === null
                ? { activeSessionId: null }
                : {}),
            ...(panes && panes.length > 1 ? { paneSessionIds: panes } : {}),
            ...(Object.keys(engines).length ? { engines } : {}),
            ...(Object.keys(ollamaModels).length ? { ollamaModels } : {}),
            ...(Object.keys(deepseekModels).length ? { deepseekModels } : {}),
            ...(Object.keys(kimiModels).length ? { kimiModels } : {}),
            ...(Object.keys(glmModels).length ? { glmModels } : {}),
            ...(Object.keys(claudeModels).length ? { claudeModels } : {}),
            ...(Object.keys(claudeEfforts).length ? { claudeEfforts } : {}),
            ...(Object.keys(claudeContextWindows).length ? { claudeContextWindows } : {}),
            ...(Object.keys(claudeFastModes).length ? { claudeFastModes } : {}),
            ...(Object.keys(claudeThinkings).length ? { claudeThinkings } : {}),
            ...(Object.keys(codexModels).length ? { codexModels } : {}),
            ...(Object.keys(codexReasoningEfforts).length ? { codexReasoningEfforts } : {}),
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
