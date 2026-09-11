/**
 * Client-side state IO — Effect wrappers
 *
 * Wraps the 4 fetch call sites inside useTabState, routing failures uniformly into AppError.
 * Same pattern as projectClient.ts, but covers the project-state / global-state /
 * scheduled-tasks endpoints.
 *
 * Business-path invocation:
 *   BrowserRuntime.runFork(updateSessionStatusEff(cwd, sessionId, status))
 *
 * Failure semantics: preserves the original silent fallback (`.catch(() => {})`);
 * on the Effect side, `Effect.either` downgrades errors to logs rather than surfacing them to the UI.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type { MarkReadBySessionIdRequest } from "@cockpit/feature-agent"

// ─────────────────────────────────────────────────────────
// project-state
// ─────────────────────────────────────────────────────────

export interface LoadedProjectState {
  sessions: string[]
  /** `null` means the active tab is a blank New Chat. */
  activeSessionId?: string | null
  /** Pane layout, by session, in on-screen order. `null` = a pane holding a chat
   *  that has no session yet. Persisted as an ARRAY rather than a
   *  `secondarySessionId` on purpose: the runtime model is N slots plus an
   *  active index, and naming one of them "secondary" here would put the
   *  primary/companion asymmetry back on disk. Length < 2 means single pane. */
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

export const loadProjectState = (
  cwd: string
): Effect.Effect<LoadedProjectState | null, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(
        `/api/project-state?cwd=${encodeURIComponent(cwd)}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as LoadedProjectState
    },
    catch: (cause) =>
      new AppError({ message: "loadProjectState failed", cause }),
  })

export interface ProjectStateSave {
  cwd: string
  sessions: string[]
  /** Always sent. `null` clears a previously active session for a blank tab. */
  activeSessionId: string | null
  /** Pane layout, by session, in on-screen order. `null` = a pane holding a chat
   *  that has no session yet. Persisted as an ARRAY rather than a
   *  `secondarySessionId` on purpose: the runtime model is N slots plus an
   *  active index, and naming one of them "secondary" here would put the
   *  primary/companion asymmetry back on disk. Length < 2 means single pane. */
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
  /** sessions explicitly closed in THIS tab — the server removes them from the shared
   *  union (the only removal path; plain saves never shrink the set). */
  closedSessionIds?: string[]
}

export const saveProjectState = (
  data: ProjectStateSave
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/project-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: "saveProjectState failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// global-state (POST update session status)
// ─────────────────────────────────────────────────────────

export const updateSessionStatus = (
  cwd: string,
  sessionId: string,
  status: string
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/global-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, sessionId, status }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: "updateSessionStatus failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// scheduled-tasks (PATCH mark read by session)
// ─────────────────────────────────────────────────────────

export const markScheduledTasksReadBySession = (
  sessionId: string
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/scheduled-tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "markReadBySessionId",
          fields: { sessionId },
        } satisfies MarkReadBySessionIdRequest),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: "markScheduledTasksReadBySession failed", cause }),
  })
