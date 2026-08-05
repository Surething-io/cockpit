/**
 * Client-side agent IO — Effect wrappers
 *
 * Wraps the ~15 fetch call sites across 7 agent-domain UI components
 * (Chat / ChatInput / OllamaModelPicker / EngineConfigPicker / TokenStatsModal /
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
// /api/<engine>/credentials + /api/<engine>/models — the API-key engines
// (deepseek, kimi). Both expose an Anthropic-compatible endpoint for SDK mode and
// an OpenAI-compatible one for Built-in Agent mode behind a single key, so the
// browser side of them is identical and parameterised by engine id.
//
// credentials GET returns only { hasKey, maskedKey }; the raw key comes back only
// from the explicit ?reveal=1 form (revealEngineApiKey), used by the picker's Copy
// button. PUT persists it (empty string clears). models is live rather than
// hardcoded — both lineups change without a cockpit release — and requires a saved
// API key.
// ─────────────────────────────────────────────────────────

/** Engines configured by API key rather than by a local CLI login. */
export type ApiKeyEngine = "deepseek" | "kimi" | "glm"

export interface EngineCredentialsInfo {
  hasKey: boolean
  maskedKey: string
}

export interface EngineModelInfo {
  id: string
  /** Provider's display name when it reports one, else the picker shows the id. */
  label?: string
  /** Context window; persisted with the model and fed to the SDK's context env. */
  contextTokens?: number
  /** Default thinking effort, likewise persisted and fed to the SDK. */
  effort?: string
}

export const loadEngineCredentials = (
  engine: ApiKeyEngine
): Effect.Effect<EngineCredentialsInfo, AppError> =>
  httpJson<EngineCredentialsInfo>(`/api/${engine}/credentials`)

/**
 * Same endpoint, asking for the plaintext. Kept a separate call so the plaintext
 * is fetched only where it is needed (copy to clipboard) instead of riding along
 * on every credentials load.
 */
export const revealEngineApiKey = (
  engine: ApiKeyEngine
): Effect.Effect<EngineCredentialsInfo & { apiKey: string }, AppError> =>
  httpJson<EngineCredentialsInfo & { apiKey: string }>(
    `/api/${engine}/credentials?reveal=1`
  )

export const saveEngineApiKey = (
  engine: ApiKeyEngine,
  apiKey: string
): Effect.Effect<EngineCredentialsInfo, AppError> =>
  httpPutJson<EngineCredentialsInfo>(`/api/${engine}/credentials`, { apiKey })

export const loadEngineModels = (
  engine: ApiKeyEngine
): Effect.Effect<{ models: EngineModelInfo[] }, AppError> =>
  httpJson<{ models: EngineModelInfo[] }>(`/api/${engine}/models`)

// ─────────────────────────────────────────────────────────
// /api/deepseek/balance — account balance, server-proxied (the raw key never
// reaches the browser). `isAvailable: false` is a successful response describing
// an unusable account, not a failure. `balances` can hold more than one currency.
// ─────────────────────────────────────────────────────────

export interface DeepseekBalanceEntry {
  currency: string
  totalBalance: string
}

export interface DeepseekBalanceInfo {
  isAvailable: boolean
  balances: DeepseekBalanceEntry[]
}

export const loadDeepseekBalance = (): Effect.Effect<
  DeepseekBalanceInfo,
  AppError
> => httpJson<DeepseekBalanceInfo>("/api/deepseek/balance")

// ─────────────────────────────────────────────────────────
// /api/<engine>/usage — remaining subscription allowance (kimi, glm), server-proxied.
// Not a balance: these are plans, so the answer is a LIST of windows (a plan cycle
// plus a rolling short one), each with its own remaining/limit and reset time.
// DeepSeek is deliberately not here — it sells prepaid credit, see loadDeepseekBalance.
// ─────────────────────────────────────────────────────────

/** Engines that report a plan allowance rather than a currency balance. */
export type QuotaEngine = "kimi" | "glm"

export interface EngineQuotaWindow {
  /** 'plan' for the subscription cycle, else a duration like '5h' / '1w'. */
  label: string
  limit: number | null
  remaining: number | null
  resetTime: string | null
}

export interface EngineQuotaInfo {
  /** Plan tier as the provider names it, e.g. 'TRIAL', 'lite'. May be ''. */
  tier: string
  windows: EngineQuotaWindow[]
}

export const loadEngineQuota = (
  engine: QuotaEngine
): Effect.Effect<EngineQuotaInfo, AppError> =>
  httpJson<EngineQuotaInfo>(`/api/${engine}/usage`)

// ─────────────────────────────────────────────────────────
// /api/ollama/config — Ollama connection config (baseUrl + apiKey), stored
// outside settings.json. GET returns the effective config (resolved values,
// masked key, per-field source); PUT { baseUrl?, apiKey? } merges — '' clears a
// field, omitted leaves it untouched.
// ─────────────────────────────────────────────────────────

export interface OllamaConfigInfo {
  baseUrl: string
  baseUrlSource: "file" | "env" | "default"
  hasKey: boolean
  maskedKey: string
  keySource: "file" | "env" | "default"
}

export const loadOllamaConfig = (): Effect.Effect<
  OllamaConfigInfo,
  AppError
> => httpJson<OllamaConfigInfo>("/api/ollama/config")

export const saveOllamaConfig = (patch: {
  baseUrl?: string
  apiKey?: string
}): Effect.Effect<OllamaConfigInfo, AppError> =>
  httpPutJson<OllamaConfigInfo>("/api/ollama/config", patch)

// ─────────────────────────────────────────────────────────
// /api/commands — builtin slash commands list.
// (Previously also merged project/global `.claude/commands/*.md` entries;
//  that convention is retired so the endpoint is now builtin-only and takes
//  no parameters.)
// ─────────────────────────────────────────────────────────

export const loadSlashCommands = <T = unknown>(): Effect.Effect<
  ReadonlyArray<T>,
  AppError
> => httpJson<ReadonlyArray<T>>("/api/commands")

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
// /api/global-state (GET) — the full persisted recent-session list (up to 100).
// Backs the recent-sessions search panel; the sidebar dropdown still streams
// its top-15 view over /ws/global-state.
// ─────────────────────────────────────────────────────────

export interface RecentSessionInfo {
  cwd: string
  sessionId: string
  lastActive: number
  status: string
  title?: string
  lastUserMessage?: string
  firstMessages?: string[]
  lastMessages?: string[]
  /** Untruncated full-text corpus (cwd + title + summary + all user messages), lowercased. */
  searchText?: string
  engine?: string
}

export const loadRecentSessions = (): Effect.Effect<
  ReadonlyArray<RecentSessionInfo>,
  AppError
> =>
  httpJson<{ sessions: RecentSessionInfo[] }>("/api/global-state").pipe(
    Effect.map((r) => r.sessions ?? [])
  )

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

// ─────────────────────────────────────────────────────────
// /api/prompts/config — chat input quick prompts (GET scope=global / cwd=, POST full array)
// ─────────────────────────────────────────────────────────

export interface PromptsConfigResponse {
  prompts?: string[]
}

/** Global scope: ?scope=global */
export const loadGlobalPromptsConfig = (): Effect.Effect<
  PromptsConfigResponse,
  AppError
> => httpJson("/api/prompts/config?scope=global")

/** Project scope: ?cwd=... */
export const loadProjectPromptsConfig = (
  cwd: string
): Effect.Effect<PromptsConfigResponse, AppError> =>
  httpJson(`/api/prompts/config?cwd=${encodeURIComponent(cwd)}`)

/**
 * Returns the prompts as actually PERSISTED — the server normalizes on write
 * (trims, drops empties, collapses duplicates), so callers must adopt this
 * instead of keeping their optimistic array.
 */
export const savePromptsConfig = (
  body: { cwd?: string; scope?: "global"; prompts: string[] }
): Effect.Effect<PromptsConfigResponse & { success?: boolean }, AppError> =>
  httpPostJson("/api/prompts/config", body)
