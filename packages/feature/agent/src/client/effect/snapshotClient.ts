/**
 * Client-side snapshot IO — Effect wrappers for /api/snapshots[/diff].
 *
 * Used by DiffViewerModal to resolve a message's real on-disk changes from
 * the shadow-git tool-call snapshots (replacing the old approach of
 * reconstructing diffs from Edit/Write tool parameters).
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// Response shapes (mirror @cockpit/effect-services snapshot types)
// ─────────────────────────────────────────────────────────

export interface SnapshotCommitDto {
  hash: string
  parent: string | null
  timestamp: number
  subject: string
  sessionKey: string | null
  toolId: string | null
  toolName: string | null
  toolFiles: string[]
  provider: string | null
  baseline: boolean
}

export interface SnapshotFileDiffDto {
  path: string
  status: "added" | "modified" | "deleted"
  binary: boolean
  additions?: number
  deletions?: number
  oldContent: string | null
  newContent: string | null
  /** Binary image: contents are null, but each side has a blob to render. */
  isImage?: boolean
  /** Revision holding the "before" blob; null when the file was added. */
  oldRev?: string | null
  /** Revision holding the "after" blob; null when the file was deleted. */
  newRev?: string | null
}

export interface SnapshotDiffDto {
  commit: SnapshotCommitDto
  files: SnapshotFileDiffDto[]
  truncated?: boolean
}

// ─────────────────────────────────────────────────────────
// HTTP primitives (local copy — same pattern as agentClient.ts)
// ─────────────────────────────────────────────────────────

const httpJson = <A>(url: string): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) => new AppError({ message: `GET ${url} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// Wrappers
// ─────────────────────────────────────────────────────────

export const loadSnapshotsByToolIds = (
  cwd: string,
  toolIds: ReadonlyArray<string>,
  sessionKey?: string
): Effect.Effect<SnapshotCommitDto[], AppError> =>
  httpJson<{ commits: SnapshotCommitDto[] }>(
    `/api/snapshots?cwd=${encodeURIComponent(cwd)}&toolIds=${encodeURIComponent(toolIds.join(","))}${
      sessionKey ? `&sessionKey=${encodeURIComponent(sessionKey)}` : ""
    }`
  ).pipe(Effect.map((r) => r.commits ?? []))

export const loadSnapshotDiff = (
  cwd: string,
  commit: string
): Effect.Effect<SnapshotDiffDto, AppError> =>
  httpJson<SnapshotDiffDto>(
    `/api/snapshots/diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commit)}`
  )

/** List a message's snapshot commits, then materialize each commit's diff. */
export const loadSnapshotDiffsForToolIds = (
  cwd: string,
  toolIds: ReadonlyArray<string>,
  sessionKey?: string
): Effect.Effect<SnapshotDiffDto[], AppError> =>
  loadSnapshotsByToolIds(cwd, toolIds, sessionKey).pipe(
    Effect.flatMap((commits) =>
      Effect.all(
        commits.map((c) => loadSnapshotDiff(cwd, c.hash)),
        { concurrency: 4 }
      )
    )
  )
