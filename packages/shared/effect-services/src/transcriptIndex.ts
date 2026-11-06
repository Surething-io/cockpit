/**
 * TranscriptIndex — the single owner of data derived from session transcripts.
 *
 * Transcripts (claude-style JSONL under ~/.claude/projects and the built-in
 * engine stores, codex rollouts under ~/.codex/sessions) are append-only, so
 * everything the UI derives from them — titles, user turns, cwd, token usage —
 * is maintained incrementally: each file is parsed from where the previous
 * read stopped, never again from byte 0 unless the file was truncated or
 * replaced. Readers get a snapshot of the folded state and build their own
 * views from it; none of them opens a transcript themselves.
 *
 * Live implementation: packages/feature/agent/src/effect/transcriptIndexLive.ts
 * Views (preview / session list / stats): packages/feature/agent/src/server/transcriptViews.ts
 */
import { Context, Effect } from "effect"
import type { FSError } from "@cockpit/effect-core"

export type TranscriptFormat = "claude" | "codex" | "pi"
/** Scans reuse resident entries without admitting cold files or promoting their recency. */
export type TranscriptCachePolicy = "retain" | "scan"

/**
 * One human turn, kept raw enough that every view can apply its own filtering
 * rules without a re-read.
 */
export interface TranscriptUserTurn {
  /**
   * claude: the content string, or the `text` of every `text` block (empty ones
   * kept as ''). codex: human `input_text` blocks after source classification.
   */
  readonly blocks: ReadonlyArray<string>
  /** Claude harness-injected context, classified by shared injectionKind rules. */
  readonly isMeta?: true
  /** codex only: classified human text, with image markup stripped. */
  readonly listText?: string
  /** codex only: number of attached images. */
  readonly images?: number
}

export interface TranscriptModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
}

/** One searchable line: a user prompt or an assistant reply, as plain text. */
export interface TranscriptCorpusLine {
  readonly role: "user" | "assistant"
  readonly text: string
}

/** Per-file usage aggregates; merged across files by the stats view. Plain JSON. */
export interface TranscriptStats {
  messages: number
  firstDate: string
  sessionIds: Record<string, 1>
  sessionTimes: Record<string, { start: number; end: number }>
  hourCounts: Record<string, number>
  daily: Record<string, { messages: number; sessions: Record<string, 1>; toolCalls: number }>
  dailyTokens: Record<string, Record<string, number>>
  modelUsage: Record<string, TranscriptModelUsage>
}

export interface TranscriptSnapshot {
  readonly path: string
  readonly format: TranscriptFormat
  readonly engine?: string
  readonly size: number
  readonly mtimeMs: number
  /** Last `ai-title` line (claude). */
  readonly aiTitle: string
  /** Last `summary` line (claude). */
  readonly summary: string
  /** First `cwd` field seen (claude). */
  readonly cwd: string | null
  readonly userTurns: ReadonlyArray<TranscriptUserTurn>
  /** Prompts and replies in order — what the search corpus is rendered from. */
  readonly corpus: ReadonlyArray<TranscriptCorpusLine>
  readonly stats: TranscriptStats
}

/**
 * One codex rollout, as its first line (`session_meta`) describes it. The first line
 * of an append-only file never changes, so it is read once per file (per inode) and
 * retried only while it has not been fully written yet.
 */
export interface CodexSessionEntry {
  readonly id: string
  readonly path: string
  readonly cwd: string
  readonly cwdRealpath: string
  /** File mtime / size at listing time (for recency ordering). */
  readonly modifiedAt: number
  readonly size: number
  /** Set when this rollout is a sub-agent codex spawned ('' when its parent is unnamed). */
  readonly parentThreadId?: string
  readonly agentRole?: string
  readonly agentNickname?: string
}

/** Process-wide parsing costs and current retained-cache usage. */
export interface TranscriptIndexCounters {
  readonly bytesParsed: number
  readonly rebuilds: number
  /** codex rollout first-line reads (the catalog's only per-file read). */
  readonly codexHeadReads: number
  readonly cachedFiles: number
  /** Conservative retained-data estimate, not a measurement of process heap usage. */
  readonly estimatedCacheBytes: number
}

export interface TranscriptIndex {
  /**
   * Bring one file up to date and return its folded state; null when the file
   * does not exist (or cannot be read).
   */
  readonly snapshot: (
    path: string,
    format: TranscriptFormat,
    cache?: TranscriptCachePolicy
  ) => Effect.Effect<TranscriptSnapshot | null, never>
  /** Batch scan with bounded read concurrency; cold entries are not retained. */
  readonly snapshots: (
    files: ReadonlyArray<{ readonly path: string; readonly format: TranscriptFormat }>
  ) => Effect.Effect<ReadonlyArray<TranscriptSnapshot | null>, never>
  /** Complete Codex inventory, newest first; native discovery failures fail rather than omit sources. */
  readonly codexSessions: Effect.Effect<ReadonlyArray<CodexSessionEntry>, FSError>
  /** The rollout for a codex thread id (or a rollout path / file name ending in one). */
  readonly resolveCodex: (threadId: string) => Effect.Effect<CodexSessionEntry | null, FSError>
  /** Forget a file's folded state; the next read rebuilds it from byte 0. */
  readonly invalidate: (path: string) => Effect.Effect<void, never>
  readonly counters: Effect.Effect<TranscriptIndexCounters, never>
}

export const TranscriptIndex = Context.GenericTag<TranscriptIndex>("@cockpit/TranscriptIndex")
