/**
 * Client-side agent IO — Effect wrappers
 *
 * Wraps the ~15 fetch call sites across 7 agent-domain UI components
 * (Chat / ChatInput / OllamaModelPicker / DeepseekConfigPicker / TokenStatsModal /
 * ProjectSessionsModal / MessageBubble).
 *
 * Complements scheduledTasksClient.ts: this file covers chat-adjacent IO for
 * session / skills / bash / ollama / settings / file / claude-stats endpoints.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// HTTP primitives
// ─────────────────────────────────────────────────────────

const httpJson = <A>(
  url: string,
  init?: RequestInit
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({
        message: `${init?.method ?? "GET"} ${url} failed`,
        cause,
      }),
  })

const httpPostJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const httpPutJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

// ─────────────────────────────────────────────────────────
// /api/settings (duplicated here to avoid an agent → workspace reverse dependency)
// ─────────────────────────────────────────────────────────

export const loadAgentSettings = <A = Record<string, unknown>>(): Effect.Effect<
  A,
  AppError
> => httpJson<A>("/api/settings")

export const saveAgentSettings = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> => httpPutJson("/api/settings", body)

// ─────────────────────────────────────────────────────────
// /api/commands — slash commands list (project + global)
// ─────────────────────────────────────────────────────────

export const loadSlashCommands = <T = unknown>(
  cwd?: string
): Effect.Effect<ReadonlyArray<T>, AppError> => {
  const url = cwd
    ? `/api/commands?cwd=${encodeURIComponent(cwd)}`
    : "/api/commands"
  return httpJson<ReadonlyArray<T>>(url)
}

// ─────────────────────────────────────────────────────────
// /api/skills
// ─────────────────────────────────────────────────────────

export interface SkillsResponse {
  skills?: ReadonlyArray<unknown>
  [key: string]: unknown
}

export const loadSkills = (): Effect.Effect<SkillsResponse, AppError> =>
  httpJson("/api/skills")

// ─────────────────────────────────────────────────────────
// /api/bash — execute shell command via Bash tool
// ─────────────────────────────────────────────────────────

export interface BashResponse {
  stdout?: string
  stderr?: string
  exitCode?: number
  [key: string]: unknown
}

export const runBashCommand = (
  body: { command: string; cwd?: string; [key: string]: unknown }
): Effect.Effect<BashResponse, AppError> => httpPostJson("/api/bash", body)

// ─────────────────────────────────────────────────────────
// /api/session-by-path (used inside Chat.tsx; complements the helper inside useChatHistory)
// ─────────────────────────────────────────────────────────

export const querySessionByPath = (
  body: Record<string, unknown>
): Effect.Effect<Record<string, unknown> | null, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/session-by-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/session-by-path failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/session/:id/fork
// ─────────────────────────────────────────────────────────

export const forkSession = <A = { sessionId?: string }>(
  sessionId: string,
  body: Record<string, unknown>
): Effect.Effect<A, AppError> =>
  httpPostJson<A>(
    `/api/session/${encodeURIComponent(sessionId)}/fork`,
    body
  )

// ─────────────────────────────────────────────────────────
// /api/sessions/projects/:encodedPath (duplicated here; backend returns an Array directly)
// ─────────────────────────────────────────────────────────

export const loadSessionsByProject = <T = unknown>(
  encodedPath: string
): Effect.Effect<ReadonlyArray<T>, AppError> =>
  httpJson(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`)

// ─────────────────────────────────────────────────────────
// /api/ollama/{models,start}
// ─────────────────────────────────────────────────────────

export interface OllamaModelsResponse {
  models?: ReadonlyArray<{ name: string; size?: number }>
  error?: string
  [key: string]: unknown
}

/** Discriminated result: Ollama process not running (503) / not installed (404) / other failure each gets its own branch. */
export type OllamaModelsResult =
  | { _tag: "ok"; models: ReadonlyArray<{ name: string; size?: number }> }
  | { _tag: "not-running" } // needs to be started first
  | { _tag: "not-installed"; message: string }
  | { _tag: "error"; message: string }

const fetchOllamaModelsRaw = (): Effect.Effect<
  OllamaModelsResult,
  AppError
> =>
  Effect.tryPromise({
    try: async (): Promise<OllamaModelsResult> => {
      const res = await fetch("/api/ollama/models")
      if (res.status === 503) return { _tag: "not-running" }
      if (!res.ok) return { _tag: "error", message: "Failed to fetch models" }
      const data = (await res.json()) as OllamaModelsResponse
      return { _tag: "ok", models: data.models ?? [] }
    },
    catch: (cause) =>
      new AppError({ message: "fetch ollama models failed", cause }),
  })

const startOllamaRaw = (): Effect.Effect<
  { _tag: "started" } | { _tag: "not-installed"; message: string } | { _tag: "error"; message: string },
  AppError
> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/ollama/start", { method: "POST" })
      const data = (await res.json().catch(() => ({}))) as {
        message?: string
      }
      if (res.status === 404) {
        return {
          _tag: "not-installed" as const,
          message: data.message || "Ollama is not installed",
        }
      }
      if (!res.ok) return { _tag: "error" as const, message: "Failed to start Ollama" }
      return { _tag: "started" as const }
    },
    catch: (cause) =>
      new AppError({ message: "start ollama failed", cause }),
  })

/**
 * Full flow: fetch → 503 triggers start → fetch again.
 * Collapses the ~40 lines of nested if/await inside OllamaModelPicker into a single Effect.gen.
 */
export const loadOllamaModelsWithAutoStart = (
  onStarting?: () => void
): Effect.Effect<OllamaModelsResult, AppError> =>
  Effect.gen(function* () {
    const first = yield* fetchOllamaModelsRaw()
    if (first._tag !== "not-running") return first

    // 503 → attempt start
    if (onStarting) yield* Effect.sync(onStarting)
    const startResult = yield* startOllamaRaw()
    if (startResult._tag === "not-installed") {
      return { _tag: "not-installed" as const, message: startResult.message }
    }
    if (startResult._tag === "error") {
      return { _tag: "error" as const, message: startResult.message }
    }

    // Started → re-fetch
    const second = yield* fetchOllamaModelsRaw()
    if (second._tag === "not-running") {
      return { _tag: "error" as const, message: "Ollama started but cannot fetch models" }
    }
    return second
  })

// ─────────────────────────────────────────────────────────
// /api/file (read content for markdown preview)
// ─────────────────────────────────────────────────────────

export interface FileReadResponse {
  content?: string
  error?: string
}

export const readFileForPreview = (
  path: string
): Effect.Effect<FileReadResponse, AppError> =>
  httpJson(`/api/file?path=${encodeURIComponent(path)}`)

// ─────────────────────────────────────────────────────────
// /api/claude-stats?engine= (token usage)
// ─────────────────────────────────────────────────────────

export const loadClaudeStats = <A = Record<string, unknown>>(
  engine: string
): Effect.Effect<A, AppError> =>
  httpJson(`/api/claude-stats?engine=${encodeURIComponent(engine)}`)
