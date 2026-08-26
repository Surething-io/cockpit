/**
 * Client-side workspace IO — Effect wrappers
 *
 * Wraps the ~20 fetch call sites across 7 workspace-domain UI components
 * (SettingsModal / TabManager / TabManagerTopBar / NoteModal / SessionBrowser /
 * EmptyState / I18nProvider).
 *
 * Complements stateClient / projectClient:
 *   - projectClient — `/api/projects` GET/POST
 *   - stateClient — project-state / global-state / scheduled-tasks
 *   - workspaceClient (this file) — settings / version / note / sessions /
 *     project-settings / pick-folder / open-vscode / open-cursor / git-worktree
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

// ─────────────────────────────────────────────────────────
// /api/settings
// ─────────────────────────────────────────────────────────

export interface SettingsResponse {
  language?: string
  [key: string]: unknown
}

export const loadSettings = (): Effect.Effect<SettingsResponse, AppError> =>
  httpJson("/api/settings")

/** Backend uses PUT for merge-update, not POST. */
export const saveSettings = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  httpJson("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

// ─────────────────────────────────────────────────────────
// /api/version & /api/extension/version
// ─────────────────────────────────────────────────────────

export const loadCockpitVersion = (): Effect.Effect<
  {
    version?: string
    /** Versions of the CLIs bundled with this Cockpit. null when not resolvable. */
    agents?: { claude: string | null; codex: string | null }
  },
  AppError
> => httpJson("/api/version")

export const loadExtensionVersion = (): Effect.Effect<
  { version?: string; installed?: boolean; path?: string },
  AppError
> => httpJson("/api/extension/version")

// ─────────────────────────────────────────────────────────
// /api/note
// ─────────────────────────────────────────────────────────

export interface NoteResponse {
  content?: string
  /** File mtime (ms) at load — the optimistic-concurrency token for saves. */
  mtime?: number
}

/**
 * Result of a save attempt. A `conflict` means the note changed on disk since
 * `baseMtime` (another tab / external editor); it carries the latest content
 * so the caller can reload instead of clobbering.
 */
export type SaveNoteResult =
  | { conflict: false; mtime?: number }
  | { conflict: true; content: string; mtime?: number }

/**
 * Global note uses `/api/note`; project note uses `/api/note?cwd=...`.
 */
const noteUrl = (cwd?: string | null) =>
  cwd ? `/api/note?cwd=${encodeURIComponent(cwd)}` : "/api/note"

export const loadNote = (
  cwd?: string | null
): Effect.Effect<NoteResponse, AppError> => httpJson(noteUrl(cwd))

/**
 * Saves the note with an optimistic-concurrency check. Unlike the generic
 * `httpPostJson` helper, a 409 here is a normal outcome (a detected conflict),
 * not a transport failure — so it is surfaced as a `SaveNoteResult` value
 * rather than an `AppError`. Genuine network/HTTP failures still fail the
 * Effect.
 */
export const saveNote = (
  cwd: string | null | undefined,
  content: string,
  baseMtime?: number
): Effect.Effect<SaveNoteResult, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const url = noteUrl(cwd)
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, baseMtime }),
      })
      if (res.status === 409) {
        const data = (await res.json()) as {
          content?: string
          mtime?: number
        }
        return {
          conflict: true as const,
          content: data.content ?? "",
          mtime: data.mtime,
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { mtime?: number }
      return { conflict: false as const, mtime: data.mtime }
    },
    catch: (cause) =>
      new AppError({ message: `POST ${noteUrl(cwd)} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/sessions/projects
// ─────────────────────────────────────────────────────────

/**
 * The sessions/projects backend returns Array<ProjectInfo> directly (not wrapped in `{projects:[]}`).
 */
export const loadSessionProjects = <T = unknown>(): Effect.Effect<
  ReadonlyArray<T>,
  AppError
> => httpJson("/api/sessions/projects")

/**
 * Fetch sessions by encoded project path — backend likewise returns Array<SessionInfo> directly.
 */
export const loadSessionsByProject = <T = unknown>(
  encodedPath: string
): Effect.Effect<ReadonlyArray<T>, AppError> =>
  httpJson(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`)

// ─────────────────────────────────────────────────────────
// /api/project-settings
// ─────────────────────────────────────────────────────────

export interface ProjectSettings {
  [key: string]: unknown
}

export const loadProjectSettings = (
  cwd: string
): Effect.Effect<ProjectSettings, AppError> =>
  httpJson(`/api/project-settings?cwd=${encodeURIComponent(cwd)}`)

export const saveProjectSettings = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  httpPostJson("/api/project-settings", body)

// ─────────────────────────────────────────────────────────
// /api/pick-folder
// ─────────────────────────────────────────────────────────

/** Backend returns `{folder: string | null}` (null = user cancelled or failed). */
export const pickFolder = (): Effect.Effect<
  { folder?: string | null },
  AppError
> => httpJson("/api/pick-folder")

// ─────────────────────────────────────────────────────────
// /api/open-vscode & /api/open-cursor (fire-and-forget)
// ─────────────────────────────────────────────────────────

export const openInVscode = (
  cwd: string
): Effect.Effect<unknown, AppError> =>
  httpPostJson("/api/open-vscode", { cwd })

export const openInCursor = (
  cwd: string
): Effect.Effect<unknown, AppError> =>
  httpPostJson("/api/open-cursor", { cwd })

// ─────────────────────────────────────────────────────────
// /api/git/worktree (GET list + POST create)
// ─────────────────────────────────────────────────────────

export interface WorktreeResponse {
  worktrees?: ReadonlyArray<unknown>
  [key: string]: unknown
}

export const loadGitWorktrees = (
  cwd: string
): Effect.Effect<WorktreeResponse, AppError> =>
  httpJson(`/api/git/worktree?cwd=${encodeURIComponent(cwd)}`)

export const createGitWorktree = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  httpPostJson("/api/git/worktree", body)
