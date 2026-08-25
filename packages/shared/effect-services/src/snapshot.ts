/**
 * SnapshotService — per-project shadow-git snapshots of AI tool calls.
 *
 * Every mutating tool call an agent performs is captured as a commit in a
 * shadow git repository (`<cockpitDir>/snapshots/<basename>-<hash12>/`,
 * GIT_DIR only — the project's own .git is never touched). Commits carry
 * structured trailers (session key / tool_use_id / tool name / declared
 * files / provider) so the chat UI can show a real on-disk diff per tool
 * call, git-history style.
 *
 * Live implementation: packages/feature/agent/src/effect/snapshotLive.ts.
 */
import { Context, Effect } from "effect"
import type { AppError, ValidationError, NotFoundError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────────────────

/** What triggered a snapshot: a finished tool call, or a run-start baseline. */
export interface SnapshotTrigger {
  readonly cwd: string
  /** Run-registry key at trigger time (real sessionId once revealed). */
  readonly sessionKey: string
  /**
   * The dispatch that produced this snapshot. Unlike `sessionKey` this is
   * stable for the whole run AND unique per run, which is what makes it the
   * only sound scope for engines whose tool ids are per-turn ephemeral:
   * codex's live stream numbers items `item_0, item_1, …` and restarts the
   * counter every turn (one `codex exec` process per turn), so `item_15`
   * from this turn collides with `item_15` from every earlier turn of the
   * SAME session. Session-scoping cannot separate them; run-scoping can.
   */
  readonly runId?: string
  /** Engine name (claude / codex / kimi / ollama / deepseek). */
  readonly provider: string
  /** tool_use id — absent for baseline snapshots. */
  readonly toolId?: string
  /** Tool name (Edit / Write / Bash / ...) — absent for baseline snapshots. */
  readonly toolName?: string
  /** Files the tool declared it would touch (absolute or cwd-relative). */
  readonly toolFiles?: ReadonlyArray<string>
  /** Human-readable detail for tools that declare no files: the Bash/Task
   *  `description` field, or the raw command as a fallback. Used (sanitized
   *  + truncated) as the commit subject so the timeline entry says WHAT the
   *  call did instead of a bare `[Bash]`. */
  readonly toolDetail?: string
}

export interface SnapshotCommit {
  readonly hash: string
  readonly parent: string | null
  /** Unix epoch seconds (committer time). */
  readonly timestamp: number
  readonly subject: string
  readonly sessionKey: string | null
  /** Dispatch that produced the commit; null on commits written before
   *  run-scoping existed (they simply fall back to session-scoping). */
  readonly runId: string | null
  readonly toolId: string | null
  readonly toolName: string | null
  /** cwd-relative files the tool declared it would touch. */
  readonly toolFiles: ReadonlyArray<string>
  readonly provider: string | null
  /** True for run-start / day-rollover baseline commits. */
  readonly baseline: boolean
}

export type SnapshotFileStatus = "added" | "modified" | "deleted"

export interface SnapshotFileDiff {
  /** cwd-relative path. */
  readonly path: string
  readonly status: SnapshotFileStatus
  readonly binary: boolean
  /** Added/deleted line counts (numstat); 0 for binary files. */
  readonly additions: number
  readonly deletions: number
  /** Content omitted when binary or over the size cap. */
  readonly oldContent: string | null
  readonly newContent: string | null
  /**
   * Binary file whose extension is an image: contents stay null (bytes never
   * travel as text), but each side can be rendered as an `<img>` against
   * /api/snapshots/blob. SVG is text, so it keeps its line diff and is NOT
   * flagged here — unlike /api/git/commit-diff, which routes on extension
   * alone and loses the SVG line diff.
   */
  readonly isImage?: boolean
  /** Revision holding the "before" blob; null when the file was added. */
  readonly oldRev?: string | null
  /** Revision holding the "after" blob; null when the file was deleted. */
  readonly newRev?: string | null
}

export interface SnapshotDiff {
  readonly commit: SnapshotCommit
  readonly files: ReadonlyArray<SnapshotFileDiff>
  /** True when the commit changed more files than the response cap. */
  readonly truncated: boolean
}

export interface SnapshotRecordResult {
  readonly committed: boolean
  readonly hash?: string
}

// ─────────────────────────────────────────────────────────
// Service Tag
// ─────────────────────────────────────────────────────────

export interface SnapshotService {
  /** Snapshot the project after a tool call; no-op when the tree is unchanged. */
  readonly record: (
    trigger: SnapshotTrigger
  ) => Effect.Effect<SnapshotRecordResult, AppError>
  /**
   * Run-start baseline: commit any pending (external / prior) changes so the
   * next tool commit's parent is exactly the pre-tool state. Also opens the
   * day branch on first use of a day.
   */
  readonly baseline: (
    cwd: string,
    sessionKey: string,
    provider: string,
    runId?: string
  ) => Effect.Effect<SnapshotRecordResult, AppError>
  /**
   * Commits whose Cockpit-Tool-Id is in `toolIds`, oldest first.
   *
   * `sessionKey` / `runId` narrow the match. `runId` is the one that makes
   * per-turn ephemeral tool ids (codex `item_N`) unambiguous — but it only
   * EXCLUDES commits that carry a *different* run id: a commit with no
   * Cockpit-Run-Id trailer (written before run-scoping) still matches, so
   * existing history keeps resolving instead of vanishing.
   */
  readonly listByToolIds: (
    cwd: string,
    toolIds: ReadonlyArray<string>,
    sessionKey?: string,
    runId?: string
  ) => Effect.Effect<ReadonlyArray<SnapshotCommit>, AppError>
  /** Full file-level diff of one snapshot commit vs its parent. */
  readonly diff: (
    cwd: string,
    commitHash: string
  ) => Effect.Effect<SnapshotDiff, AppError | ValidationError | NotFoundError>
  /**
   * Raw bytes of an IMAGE blob at a snapshot revision — what makes the image
   * side of a snapshot diff renderable. The project's own repo has no such
   * objects (snapshots live in a separate GIT_DIR), so /api/git/blob cannot
   * serve these. Non-image extensions are rejected.
   */
  readonly blob: (
    cwd: string,
    rev: string,
    file: string
  ) => Effect.Effect<Uint8Array<ArrayBuffer>, AppError | ValidationError | NotFoundError>
  /** Retention pass: drop day branches beyond keepDays, gc, remove dead repos. */
  readonly cleanup: Effect.Effect<void, AppError>
}

export const SnapshotService = Context.GenericTag<SnapshotService>(
  "@cockpit/SnapshotService"
)
