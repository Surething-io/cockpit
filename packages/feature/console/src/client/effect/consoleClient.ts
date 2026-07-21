/**
 * Client-side console IO — Effect wrappers
 *
 * Wraps every fetch call inside useConsoleState, routing failures uniformly into AppError.
 *
 * Covers history (GET/POST/DELETE/PATCH) plus bubble-order (POST), converting all 11 fetch
 * call sites inside useConsoleState.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type { CustomCommand } from "@/app/api/services/config/route"

const httpGet = <A>(url: string): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `fetch ${url} failed`, cause }),
  })

const httpSend = (
  url: string,
  init: RequestInit
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: `${init.method} ${url} failed`, cause }),
  })

const httpPostJson = (
  url: string,
  body: unknown
): Effect.Effect<void, AppError> =>
  httpSend(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

/** POST variant that parses the response body (for endpoints that echo state). */
const httpPostJsonFor = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) => new AppError({ message: `POST ${url} failed`, cause }),
  })

const httpPatchJson = (
  url: string,
  body: unknown
): Effect.Effect<void, AppError> =>
  httpSend(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const httpDelete = (url: string): Effect.Effect<void, AppError> =>
  httpSend(url, { method: "DELETE" })

// ─────────────────────────────────────────────────────────
// terminal/env (cwd + optional tabId)
// ─────────────────────────────────────────────────────────

export const loadTerminalEnv = (
  cwd: string,
  tabId?: string
): Effect.Effect<Record<string, string>, AppError> =>
  Effect.gen(function* () {
    const params = new URLSearchParams({ cwd })
    if (tabId) params.set("tabId", tabId)
    const data = yield* httpGet<{ env?: Record<string, string> }>(
      `/api/terminal/env?${params}`
    )
    return data.env || {}
  })

// ─────────────────────────────────────────────────────────
// terminal/aliases (global)
// ─────────────────────────────────────────────────────────

export const loadAliases = (): Effect.Effect<
  Record<string, string>,
  AppError
> =>
  httpGet<{ aliases?: Record<string, string> }>("/api/terminal/aliases").pipe(
    Effect.map((data) => data.aliases || {})
  )

// ─────────────────────────────────────────────────────────
// terminal/bubble-order
// ─────────────────────────────────────────────────────────

export const loadBubbleOrder = (
  cwd: string,
  tabId: string
): Effect.Effect<string[], AppError> =>
  httpGet<{ order?: string[] }>(
    `/api/terminal/bubble-order?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}`
  ).pipe(Effect.map((data) => data.order || []))

export const saveBubbleOrder = (
  cwd: string,
  tabId: string,
  order: string[],
  sourceId?: string
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/terminal/bubble-order", { cwd, tabId, order, sourceId })

// ─────────────────────────────────────────────────────────
// terminal/history
// ─────────────────────────────────────────────────────────

export interface HistoryEntriesResponse {
  entries: Array<Record<string, unknown>>
  hasMore: boolean
}

/**
 * Paginated load of terminal history (commands + plugin items).
 */
export const loadHistoryPage = (
  cwd: string,
  tabId: string,
  page: number,
  pageSize: number = 100
): Effect.Effect<HistoryEntriesResponse, AppError> =>
  httpGet<HistoryEntriesResponse>(
    `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&page=${page}&pageSize=${pageSize}`
  )

/**
 * Persist a single history entry (command or plugin item).
 */
export const saveHistoryEntry = (
  cwd: string,
  tabId: string,
  entry: Record<string, unknown>,
  sourceId?: string
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/terminal/history", { cwd, tabId, entry, sourceId })

/**
 * Delete a single history entry.
 */
export const deleteHistoryEntry = (
  cwd: string,
  tabId: string,
  commandId: string,
  sourceId?: string
): Effect.Effect<void, AppError> =>
  httpDelete(
    `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&commandId=${encodeURIComponent(commandId)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ""}`
  )

/**
 * Partial update of a single history entry (commonly used for the sleeping marker).
 */
export const patchHistoryEntry = (
  cwd: string,
  tabId: string,
  id: string,
  fields: Record<string, unknown>,
  sourceId?: string
): Effect.Effect<void, AppError> =>
  httpPatchJson("/api/terminal/history", { cwd, tabId, id, fields, sourceId })

// ─────────────────────────────────────────────────────────
// terminal/env (POST — save env vars)
// ─────────────────────────────────────────────────────────

/** Save terminal env (global when tabId is omitted, or scoped to a specific tab). */
export const saveTerminalEnv = (
  body: {
    cwd: string
    tabId?: string
    env: Record<string, string>
  }
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/terminal/env", body)

// ─────────────────────────────────────────────────────────
// terminal/aliases (POST — save user aliases)
// ─────────────────────────────────────────────────────────

export const saveAliases = (
  aliases: Record<string, string>
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/terminal/aliases", { aliases })

// ─────────────────────────────────────────────────────────
// terminal/register & terminal/unregister
// ─────────────────────────────────────────────────────────

/**
 * Register a running command into the global RunningCommandRegistry
 * (enables cross-tab termination / PTY reconnection).
 */
export const registerRunningCommand = (
  body: Record<string, unknown>
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/terminal/register", body)

export const unregisterRunningCommand = (
  body: Record<string, unknown>
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/terminal/unregister", body)

// ─────────────────────────────────────────────────────────
// terminal/autocomplete
// ─────────────────────────────────────────────────────────

export interface AutocompleteResponse {
  suggestions?: ReadonlyArray<string>
  replaceStart?: number
  replaceEnd?: number
  [key: string]: unknown
}

export const fetchAutocomplete = (body: {
  cwd: string
  input: string
  cursorPosition: number
}): Effect.Effect<AutocompleteResponse, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/terminal/autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as AutocompleteResponse
    },
    catch: (cause) =>
      new AppError({
        message: "POST /api/terminal/autocomplete failed",
        cause,
      }),
  })

// ─────────────────────────────────────────────────────────
// project-settings (per-cwd panel/tool settings; workspace has a wrapper with the same name —
// kept independent here to avoid a console → workspace reverse dependency)
// ─────────────────────────────────────────────────────────

export const loadProjectSettings = (
  cwd: string
): Effect.Effect<Record<string, unknown>, AppError> =>
  httpGet(`/api/project-settings?cwd=${encodeURIComponent(cwd)}`)

export const saveProjectSettings = (
  body: { cwd: string; settings: Record<string, unknown> }
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/project-settings", body)

// ─────────────────────────────────────────────────────────
// services/config (GET scope=global / cwd=, POST upsert)
// ─────────────────────────────────────────────────────────

export interface ServicesConfigResponse {
  configs?: ReadonlyArray<unknown>
  [key: string]: unknown
}

/** Global scope: ?scope=global */
export const loadGlobalServicesConfig = (): Effect.Effect<
  ServicesConfigResponse,
  AppError
> => httpGet("/api/services/config?scope=global")

/** Project scope: ?cwd=... */
export const loadProjectServicesConfig = (
  cwd: string
): Effect.Effect<ServicesConfigResponse, AppError> =>
  httpGet(`/api/services/config?cwd=${encodeURIComponent(cwd)}`)

/**
 * Returns the commands as actually PERSISTED — the server normalizes on write
 * (renames duplicates, drops unusable entries), so callers must adopt this
 * instead of keeping their optimistic array.
 */
export const saveServicesConfig = (
  body: Record<string, unknown>
): Effect.Effect<{ customCommands?: CustomCommand[] }, AppError> =>
  httpPostJsonFor("/api/services/config", body)
