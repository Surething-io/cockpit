/**
 * Git Client — Effect wrappers for git-related HTTP endpoints.
 *
 * Wraps the fetch calls used by useGitHistory / useGitStatus / GitWorktreeModal so
 * hooks can call them via useEffectQuery / useEffectMutation. Follows the same
 * shape as projectClient.ts.
 */
import { Effect } from "effect"
import { AppError, NotFoundError } from "@cockpit/effect-core"

interface BranchesResponse {
  local?: string[]
  remote?: string[]
  current?: string
  upstream?: string
  error?: string
}

interface CommitsResponse {
  commits?: ReadonlyArray<unknown>
  error?: string
}

interface CommitDiffResponse {
  files?: ReadonlyArray<unknown>
  // When called with a `file` query param the backend returns the full FileDiff.
  [key: string]: unknown
}

interface BranchDiffResponse {
  files?: ReadonlyArray<unknown>
  // When called with a `file` query param the backend returns the full FileDiff.
  [key: string]: unknown
}

const httpGet = <A>(url: string): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url)
      if (!res.ok) {
        // Extract backend `error` field as cause to preserve toast/setStatusError context
        let bodyError: string | undefined
        try {
          const data = (await res.json()) as { error?: string }
          bodyError = data.error
        } catch {
          /* not JSON */
        }
        throw new Error(bodyError || `HTTP ${res.status}`)
      }
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `fetch ${url} failed`, cause }),
  })

const httpPostJson = (
  url: string,
  body: unknown
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: `POST ${url} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// API client functions
// ─────────────────────────────────────────────────────────

export const fetchBranches = (
  cwd: string
): Effect.Effect<BranchesResponse, AppError | NotFoundError> =>
  httpGet<BranchesResponse>(
    `/api/git/branches?cwd=${encodeURIComponent(cwd)}`
  ).pipe(
    Effect.flatMap((data) =>
      data.error === "Failed to get branches"
        ? Effect.fail(new NotFoundError({ resource: "git-repo", id: cwd }))
        : Effect.succeed(data)
    )
  )

/**
 * Fetch commit history for a branch (supports paginated offset).
 */
export const fetchCommits = (
  cwd: string,
  branch: string,
  limit: number,
  offset?: number
): Effect.Effect<CommitsResponse, AppError> => {
  const url = `/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}&limit=${limit}${typeof offset === "number" ? `&offset=${offset}` : ""}`
  return httpGet<CommitsResponse>(url)
}

/**
 * Fetch the file list for a commit; if `file` is provided, returns the FileDiff for that file.
 */
export const fetchCommitDiff = (
  cwd: string,
  hash: string,
  file?: string
): Effect.Effect<CommitDiffResponse, AppError> => {
  const url = `/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}${file ? `&file=${encodeURIComponent(file)}` : ""}`
  return httpGet<CommitDiffResponse>(url)
}

/**
 * Branch diff: HEAD vs base. Returns FileDiff when `file` is provided, otherwise a file list.
 */
export const fetchBranchDiff = (
  cwd: string,
  base: string,
  file?: string
): Effect.Effect<BranchDiffResponse, AppError> => {
  const url = `/api/git/branch-diff?cwd=${encodeURIComponent(cwd)}&base=${encodeURIComponent(base)}${file ? `&file=${encodeURIComponent(file)}` : ""}`
  return httpGet<BranchDiffResponse>(url)
}

// ─────────────────────────────────────────────────────────
// Status / Mutations (covers the 13 useGitStatus call sites)
// ─────────────────────────────────────────────────────────

export interface GitStatusResponseShape {
  staged: ReadonlyArray<unknown>
  unstaged: ReadonlyArray<unknown>
  [key: string]: unknown
}

/**
 * Fetch the working tree staged / unstaged lists. On backend 4xx, body.error is lifted to cause.message.
 */
export const fetchGitStatus = (
  cwd: string
): Effect.Effect<GitStatusResponseShape, AppError> =>
  httpGet<GitStatusResponseShape>(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)

/**
 * Stage files.
 */
export const stageFiles = (
  cwd: string,
  files: ReadonlyArray<string>
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/git/stage", { cwd, files })

/**
 * Unstage files.
 */
export const unstageFiles = (
  cwd: string,
  files: ReadonlyArray<string>
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/git/unstage", { cwd, files })

/**
 * Discard files: isUntracked=true deletes untracked files, false restores tracked files.
 */
export const discardFiles = (
  cwd: string,
  files: ReadonlyArray<string>,
  isUntracked: boolean
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/git/discard", { cwd, files, isUntracked })

/**
 * Working tree single-file diff (staged / unstaged view).
 */
export const fetchGitDiff = (
  cwd: string,
  file: string,
  type: "staged" | "unstaged"
): Effect.Effect<unknown, AppError> => {
  const params = new URLSearchParams({ cwd, file, type })
  return httpGet(`/api/git/diff?${params}`)
}

/**
 * Accepts a pre-assembled query string (BlockDiffViewer supplies its own cwd/file/range and other parameters).
 */
export const fetchGitDiffRaw = <A = unknown>(
  qs: URLSearchParams | string
): Effect.Effect<A, AppError> =>
  httpGet<A>(`/api/git/diff?${qs.toString()}`)

// ─────────────────────────────────────────────────────────
// Worktree (GET list + POST action)
// ─────────────────────────────────────────────────────────

export interface WorktreeListResponse {
  worktrees?: ReadonlyArray<unknown>
  isGitRepo?: boolean
  [key: string]: unknown
}

export const fetchGitWorktrees = (
  cwd: string
): Effect.Effect<WorktreeListResponse, AppError> =>
  httpGet(`/api/git/worktree?cwd=${encodeURIComponent(cwd)}`)

/**
 * /api/git/worktree POST — dispatches add / remove / checkout / lock / unlock actions.
 * On 4xx, body.error is lifted to cause.message.
 */
export const postGitWorktree = <A = unknown>(
  body: Record<string, unknown>
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/git/worktree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`)
      }
      return data as A
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/git/worktree failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/projectGraph/search — function-level symbol search
// ─────────────────────────────────────────────────────────

export const fetchProjectGraphSearch = <A = unknown>(
  qs: URLSearchParams | string
): Effect.Effect<A, AppError> =>
  httpGet<A>(`/api/projectGraph/search?${qs.toString()}`)
