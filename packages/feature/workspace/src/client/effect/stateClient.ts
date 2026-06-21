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

// ─────────────────────────────────────────────────────────
// project-state
// ─────────────────────────────────────────────────────────

export interface LoadedProjectState {
  sessions: string[]
  activeSessionId?: string
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  chatModes?: Record<string, string>
  planModes?: Record<string, boolean>
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
  activeSessionId?: string
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  chatModes?: Record<string, string>
  planModes?: Record<string, boolean>
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
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: "markScheduledTasksReadBySession failed", cause }),
  })
