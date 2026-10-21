/**
 * TranscriptIndexLive — incremental fold over append-only transcripts.
 *
 * Why: every reader of transcript-derived data used to re-parse raw JSONL on the
 * request path, each behind its own ad-hoc cache (a 40-entry LRU, a 5-minute TTL,
 * a per-project list cache). Their cost grew with total history (~500 MB of
 * transcripts behind a 100-entry recent list), and any cache miss paid it again.
 * Here a file's cost is paid once per byte appended.
 *
 * Per file (Memento), persisted as one shard under <cockpitDir>/transcript-index/:
 *   { ino, size, mtimeMs, offset, anchor, ...folded state }
 * `offset` only ever advances to just past the last complete line, so a half-written
 * line is re-read next time. `anchor` is the 64 bytes before `offset`.
 *
 * refresh(path):
 *   same ino + size + mtime                  → noop (one stat)
 *   same ino, grown, anchor holds            → tail: parse [offset, size) only
 *   otherwise (replaced, truncated, same size
 *   but touched, anchor changed)             → rebuild from byte 0
 *
 * Correctness rests on transcripts only growing. Engines' CLIs only append; every
 * rewrite Cockpit makes goes through transcriptWrite.ts, which replaces the file
 * (new inode) and calls invalidateTranscript — so a rewrite never reaches the
 * "tail" branch. The anchor is a backstop for writers outside that contract.
 *
 * Each line goes through the engine's adapter into `foldClaudeLine` /
 * `foldCodexLine`, which update every derived field in one pass (title, cwd, user
 * turns, usage stats). Views are built from the snapshot by transcriptViews.ts.
 *
 * State is pinned to globalThis: the WS server realm (server.mjs) and the Next
 * route realm both read transcripts, and a second realm must not grow a second
 * index (same rationale as snapshotLive's semaphores and sessionRunHub).
 */
import { createHash } from "node:crypto"
import { open, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { CockpitConfig, FSError } from "@cockpit/effect-core"
import { CODEX_SESSIONS_DIR, normalizeCodexSessionId } from "@cockpit/shared-utils"
import {
  TranscriptIndex,
  type CodexSessionEntry,
  type TranscriptFormat,
  type TranscriptIndexCounters,
  type TranscriptSnapshot,
  type TranscriptCorpusLine,
  type TranscriptStats,
  type TranscriptUserTurn,
} from "@cockpit/effect-services"
import { extractCodexUserContent } from "../server/api/session/codexTools"
import { getOwn, setOwn } from "../server/transcriptViews"
import { queuedPromptAsUserEntry } from "../shared/transcriptTurns"
import { writeAtomically } from "@cockpit/effect-runtime/server/fs"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Bump when the folded shape or a fold rule changes: every shard rebuilds once. */
export const TRANSCRIPT_INDEX_VERSION = 4
const READ_CONCURRENCY = 4
const ANCHOR_BYTES = 64
const CHUNK_BYTES = 1024 * 1024
const FLUSH_DELAY = "3 seconds"

// ─────────────────────────────────────────────────────────
// Folded state (pure)
// ─────────────────────────────────────────────────────────

interface Entry {
  v: number
  path: string
  format: TranscriptFormat
  ino: number
  size: number
  mtimeMs: number
  offset: number
  anchor: string
  aiTitle: string
  summary: string
  cwd: string | null
  userTurns: TranscriptUserTurn[]
  corpus: TranscriptCorpusLine[]
  stats: TranscriptStats
  /** Lines no decoder accepted (malformed or of no interest to any view). */
  skippedLines: number
}

export const emptyStats = (): TranscriptStats => ({
  messages: 0,
  firstDate: "",
  sessionIds: {},
  sessionTimes: {},
  hourCounts: {},
  daily: {},
  dailyTokens: {},
  modelUsage: {},
})

/** Fold target for one file: everything but the file identity fields. */
export type FoldState = Pick<Entry, "aiTitle" | "summary" | "cwd" | "userTurns" | "corpus" | "stats">

export const emptyFoldState = (): FoldState => ({
  aiTitle: "",
  summary: "",
  cwd: null,
  userTurns: [],
  corpus: [],
  stats: emptyStats(),
})

const emptyEntry = (path: string, format: TranscriptFormat, ino: number): Entry => ({
  v: TRANSCRIPT_INDEX_VERSION,
  path,
  format,
  ino,
  size: 0,
  mtimeMs: 0,
  offset: 0,
  anchor: "",
  skippedLines: 0,
  ...emptyFoldState(),
})

/** Copy-on-write before a tail, so a snapshot already handed out never changes. */
const cloneEntry = (e: Entry): Entry => ({
  ...e,
  userTurns: [...e.userTurns],
  corpus: [...e.corpus],
  stats: structuredClone(e.stats),
})

const toSnapshot = (e: Entry): TranscriptSnapshot => ({
  path: e.path,
  format: e.format,
  size: e.size,
  mtimeMs: e.mtimeMs,
  aiTitle: e.aiTitle,
  summary: e.summary,
  cwd: e.cwd,
  userTurns: e.userTurns,
  corpus: e.corpus,
  stats: e.stats,
})

// Decode → apply. Each format's decoder is TOTAL: it validates the shape of one line
// and returns a typed record, or null for anything it does not recognise — it never
// throws. `applyRecord` only ever sees validated records, so it cannot throw either,
// and a malformed line costs exactly that line (counted in `skippedLines`), never the
// rest of the file. Shape checks live in the decoders and nowhere else.

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const parseLine = (line: string): JsonRecord | null => {
  try {
    const v: unknown = JSON.parse(line)
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

/** One validated transcript line, in the fields any reducer reads. */
export interface TranscriptRecord {
  /** Line `type` ('user' / 'assistant' / 'summary' / …); codex records use 'user' / 'assistant'. */
  readonly type: string
  readonly sessionId?: string
  readonly timestamp?: string
  readonly cwd?: string
  readonly aiTitle?: string
  readonly summary?: string
  readonly userTurn?: TranscriptUserTurn
  readonly assistant?: {
    readonly model?: string
    readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheCreation: number }
    readonly toolUses: number
  }
  /** Searchable text this line contributes (user prompt or assistant reply). */
  readonly corpusText?: string
}

/** Claude-format decoder (claude CLI + the built-in engine stores). */
export const decodeClaudeLine = (line: string): TranscriptRecord | null => {
  const d = parseLine(line)
  if (!d) return null
  // A prompt sent while a run was busy is stored as an `attachment/queued_command`; the
  // chat view shows it as a user message via the shared normaliser, so search must see
  // it too. Corpus only: session lists and previews have never included these.
  const queued = queuedPromptAsUserEntry(d)
  if (queued) {
    const content = queued.message.content
    const text =
      typeof content === "string"
        ? content
        : content.filter(isRecord).filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n")
    return {
      type: "attachment",
      sessionId: str(d.sessionId) || undefined,
      timestamp: str(d.timestamp) || undefined,
      corpusText: text.trim() ? text : undefined,
    }
  }
  const type = str(d.type) ?? ""
  const message = isRecord(d.message) ? d.message : undefined
  const content = message?.content
  const blocks = Array.isArray(content) ? content.filter(isRecord) : []

  let userTurn: TranscriptUserTurn | undefined
  if (type === "user" && content) {
    const texts =
      typeof content === "string"
        ? [content]
        : blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "")
    if (texts.length > 0) userTurn = d.isMeta === true ? { blocks: texts, isMeta: true } : { blocks: texts }
  }

  let assistant: TranscriptRecord["assistant"]
  let assistantText = ""
  if (type === "assistant" && message) {
    const usage = isRecord(message.usage) ? message.usage : undefined
    assistant = {
      model: str(message.model),
      usage: usage && {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
      },
      toolUses: blocks.filter((b) => b.type === "tool_use").length,
    }
    assistantText = blocks
      .filter((b) => b.type === "text")
      .map((b) => str(b.text) ?? "")
      .join("\n")
  }

  const corpusText = userTurn && !userTurn.isMeta ? userTurn.blocks.join("\n") : assistantText
  return {
    type,
    sessionId: str(d.sessionId) || undefined,
    timestamp: str(d.timestamp) || undefined,
    cwd: str(d.cwd) || undefined,
    aiTitle: type === "ai-title" ? str(d.aiTitle) || undefined : undefined,
    summary: type === "summary" ? str(d.summary) || undefined : undefined,
    userTurn,
    assistant,
    corpusText: corpusText.trim() ? corpusText : undefined,
  }
}

const isCodexSystemText = (text: string): boolean => text.startsWith("<") || text.startsWith("#")

/** Codex rollout decoder: only human and assistant `response_item` messages matter. */
export const decodeCodexLine = (line: string): TranscriptRecord | null => {
  if (!line.trim()) return null
  const d = parseLine(line)
  if (!d || !isRecord(d.payload)) return null
  const payload = d.payload
  // A failed turn: codex records the reason only here, and the chat shows it as the
  // turn's ⚠️ banner (transcriptParsers.ts, same text) — so it is searchable too.
  if (d.type === "event_msg" && payload.type === "task_complete") {
    const message = isRecord(payload.error) ? str(payload.error.message) : undefined
    return message ? { type: "assistant", corpusText: `⚠️ ${message}` } : null
  }
  if (d.type !== "response_item") return null
  if (payload.type !== "message" || !Array.isArray(payload.content)) return null
  // Field types are checked per block kind before anything else reads them:
  // extractCodexUserContent assumes the strings codex writes.
  const content = payload.content.filter(isRecord).filter((c) => {
    if (c.type === "input_text" || c.type === "output_text") return typeof c.text === "string"
    if (c.type === "input_image") return typeof c.image_url === "string"
    return true
  })

  if (payload.role === "assistant") {
    const text = content
      .filter((c) => c.type === "output_text")
      .map((c) => str(c.text) ?? "")
      .join("\n")
    return text.trim() ? { type: "assistant", corpusText: text } : null
  }
  if (payload.role !== "user") return null
  const blocks = content.filter((c) => c.type === "input_text" && str(c.text)).map((c) => c.text as string)
  const { text, images } = extractCodexUserContent(content as Parameters<typeof extractCodexUserContent>[0])
  if (blocks.length === 0 && images.length === 0 && !text) return null
  // Searchable text is the prompt as the chat shows it: image tags/markup stripped
  // (the raw blocks of an image prompt start with `<image …>`), system text dropped.
  return {
    type: "user",
    userTurn: { blocks, listText: text, images: images.length },
    corpusText: text && !isCodexSystemText(text) ? text : undefined,
  }
}

/**
 * Usage aggregates — the per-line rules /api/claude-stats has always applied, now
 * folded once per line instead of once per line per 5 minutes.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/

const applyStats = (s: TranscriptStats, r: TranscriptRecord): void => {
  const { type, sessionId, timestamp } = r
  if (sessionId) setOwn(s.sessionIds, sessionId, 1)
  if (sessionId && timestamp) {
    const ts = new Date(timestamp).getTime()
    if (!isNaN(ts)) {
      const t = getOwn(s.sessionTimes, sessionId)
      if (!t) setOwn(s.sessionTimes, sessionId, { start: ts, end: ts })
      else {
        if (ts < t.start) t.start = ts
        if (ts > t.end) t.end = ts
      }
    }
  }

  // A day bucket only for a real calendar date: the key comes from transcript text.
  const prefix = timestamp?.slice(0, 10)
  const date = prefix && DATE.test(prefix) ? prefix : undefined
  if (date && (!s.firstDate || date < s.firstDate)) s.firstDate = date

  if (timestamp && type === "user") {
    const hour = new Date(timestamp).getHours()
    if (!isNaN(hour)) setOwn(s.hourCounts, String(hour), (getOwn(s.hourCounts, String(hour)) || 0) + 1)
  }

  const dayOf = (day: string) =>
    getOwn(s.daily, day) ?? setOwn(s.daily, day, { messages: 0, sessions: {}, toolCalls: 0 })

  if (type === "user") {
    s.messages++
    if (date && sessionId) {
      const daily = dayOf(date)
      daily.messages++
      setOwn(daily.sessions, sessionId, 1)
    }
  }

  if (type === "assistant") {
    s.messages++
    const a = r.assistant
    if (!a) return
    if (a.model && a.usage) {
      const mu =
        getOwn(s.modelUsage, a.model) ??
        setOwn(s.modelUsage, a.model, {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
        })
      mu.inputTokens += a.usage.input
      mu.outputTokens += a.usage.output
      mu.cacheReadInputTokens += a.usage.cacheRead
      mu.cacheCreationInputTokens += a.usage.cacheCreation
      if (date) {
        const dtm = getOwn(s.dailyTokens, date) ?? setOwn(s.dailyTokens, date, {})
        const total = a.usage.input + a.usage.output + a.usage.cacheRead + a.usage.cacheCreation
        setOwn(dtm, a.model, (getOwn(dtm, a.model) || 0) + total)
      }
    }
    if (date && a.toolUses > 0) dayOf(date).toolCalls += a.toolUses
  }
}

/** Every reducer, over one validated record. Total: no reducer can throw. */
export const applyRecord = (state: FoldState, format: TranscriptFormat, r: TranscriptRecord): void => {
  if (format === "claude") {
    applyStats(state.stats, r)
    if (state.cwd === null && r.cwd) state.cwd = r.cwd
    if (r.aiTitle) state.aiTitle = r.aiTitle
    if (r.summary) state.summary = r.summary
  }
  if (r.userTurn) state.userTurns.push(r.userTurn)
  if (r.corpusText) state.corpus.push({ role: r.type === "assistant" ? "assistant" : "user", text: r.corpusText })
}

const DECODERS: Record<TranscriptFormat, (line: string) => TranscriptRecord | null> = {
  claude: decodeClaudeLine,
  codex: decodeCodexLine,
}

/** Fold one line into `state`; returns false when the line was skipped. */
export const foldLine = (state: FoldState, format: TranscriptFormat, line: string): boolean => {
  // Decoders and reducers are meant to be total; this boundary — around BOTH — is
  // what guarantees a bug in either costs one line, never the rest of the file.
  try {
    const record = DECODERS[format](line)
    if (!record) return false
    applyRecord(state, format, record)
    return true
  } catch {
    return false
  }
}

/** Compatibility shims for the per-format fold the tests drive directly. */
export const foldClaudeLine = (state: FoldState, line: string): void => void foldLine(state, "claude", line)
export const foldCodexLine = (state: FoldState, line: string): void => void foldLine(state, "codex", line)

// ─────────────────────────────────────────────────────────
// Iterator: complete lines from a byte offset
// ─────────────────────────────────────────────────────────

type FileHandle = Awaited<ReturnType<typeof open>>

/**
 * Feed every complete line in [from, to) to `onLine`; returns the bytes consumed
 * (through the last '\n'). A trailing partial line is left for the next read.
 */
const forEachLine = async (
  fh: FileHandle,
  from: number,
  to: number,
  onLine: (line: string) => void
): Promise<number> => {
  let pos = from
  let carry: Buffer = Buffer.alloc(0)
  let consumed = 0
  while (pos < to) {
    const want = Math.min(CHUNK_BYTES, to - pos)
    const chunk = Buffer.alloc(want)
    const { bytesRead } = await fh.read(chunk, 0, want, pos)
    if (bytesRead <= 0) break
    pos += bytesRead
    const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
    const lastNl = buf.lastIndexOf(10)
    if (lastNl < 0) {
      carry = buf
      continue
    }
    let start = 0
    while (start <= lastNl) {
      const nl = buf.indexOf(10, start)
      let end = nl
      if (end > start && buf[end - 1] === 13) end-- // CRLF
      if (end > start) onLine(buf.toString("utf8", start, end))
      start = nl + 1
    }
    consumed += lastNl + 1
    carry = buf.subarray(lastNl + 1)
  }
  return consumed
}

const readAnchor = async (fh: FileHandle, offset: number): Promise<string> => {
  if (offset <= 0) return ""
  const start = Math.max(0, offset - ANCHOR_BYTES)
  const buf = Buffer.alloc(offset - start)
  const { bytesRead } = await fh.read(buf, 0, buf.length, start)
  return buf.subarray(0, bytesRead).toString("base64")
}

// ─────────────────────────────────────────────────────────
// Process-wide state (pinned to globalThis, keyed by shard dir)
// ─────────────────────────────────────────────────────────

interface IndexState {
  readonly entries: Map<string, Entry>
  /** Paths whose shard has been looked up on disk this process (hit or miss). */
  readonly probed: Set<string>
  readonly dirty: Set<string>
  flushScheduled: boolean
  readonly pathLocks: Map<string, Effect.Semaphore>
  readonly readSem: Effect.Semaphore
  bytesParsed: number
  rebuilds: number
  /** codex rollout path → first-line view; see "Codex catalog" below. */
  readonly codexHeads: Map<string, CodexHead>
  codexHeadsLoad: Promise<void> | null
  codexHeadsDirty: boolean
  codexHeadsFlushScheduled: boolean
  /** directory → its last listing, reused while the directory's mtime is unchanged. */
  readonly codexDirs: Map<string, { mtimeMs: number; dirs: string[]; files: string[] }>
  /** thread id → rollout paths; null = rebuild from codexHeads on next use. */
  codexById: Map<string, string[]> | null
  codexHeadReads: number
  /** In-flight first-line reads, by path: concurrent callers share one read. */
  readonly codexHeadInflight: Map<string, Promise<CodexMeta | null>>
  /** In-flight directory walk: concurrent listings / misses share one walk. */
  codexWalkInflight: Promise<string[]> | null
}

const gIndex = globalThis as unknown as { __cockpitTranscriptIndex?: Map<string, IndexState> }
const states: Map<string, IndexState> = gIndex.__cockpitTranscriptIndex ?? (gIndex.__cockpitTranscriptIndex = new Map())

const stateFor = (shardDir: string): IndexState => {
  let s = states.get(shardDir)
  if (!s) {
    s = {
      entries: new Map(),
      probed: new Set(),
      dirty: new Set(),
      flushScheduled: false,
      pathLocks: new Map(),
      readSem: Effect.unsafeMakeSemaphore(READ_CONCURRENCY),
      bytesParsed: 0,
      rebuilds: 0,
      codexHeads: new Map(),
      codexHeadsLoad: null,
      codexHeadsDirty: false,
      codexHeadsFlushScheduled: false,
      codexDirs: new Map(),
      codexById: null,
      codexHeadReads: 0,
      codexHeadInflight: new Map(),
      codexWalkInflight: null,
    }
    states.set(shardDir, s)
  }
  return s
}

const shardPath = (shardDir: string, path: string): string =>
  join(shardDir, `${createHash("sha1").update(path).digest("hex").slice(0, 24)}.json`)

const withPathLock = <A, E>(s: IndexState, path: string, eff: Effect.Effect<A, E>): Effect.Effect<A, E> => {
  let sem = s.pathLocks.get(path)
  if (!sem) {
    sem = Effect.unsafeMakeSemaphore(1)
    s.pathLocks.set(path, sem)
  }
  return sem.withPermits(1)(eff)
}

// ─────────────────────────────────────────────────────────
// Persistence (Memento shards)
// ─────────────────────────────────────────────────────────

const loadShard = async (shardDir: string, path: string): Promise<Entry | null> => {
  try {
    const e = JSON.parse(await readFile(shardPath(shardDir, path), "utf8")) as Entry
    return e.v === TRANSCRIPT_INDEX_VERSION && e.path === path ? e : null
  } catch {
    return null
  }
}

const flush = (shardDir: string, s: IndexState): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    s.flushScheduled = false
    const paths = [...s.dirty]
    s.dirty.clear()
    yield* Effect.forEach(
      paths,
      (p) => {
        const file = shardPath(shardDir, p)
        const e = s.entries.get(p)
        return Effect.tryPromise({
          try: () => (e ? writeAtomically(file, JSON.stringify(e)) : rm(file, { force: true })),
          catch: (cause) => new FSError({ path: file, op: e ? "write" : "rm", cause }),
        }).pipe(
          // Keep it dirty: the next flush retries.
          Effect.catchAll((err) =>
            Effect.sync(() => s.dirty.add(p)).pipe(
              Effect.zipRight(Effect.logWarning("transcript index: shard write failed").pipe(Effect.annotateLogs({ path: err.path })))
            )
          )
        )
      },
      { concurrency: 4, discard: true }
    )
  })

const markDirty = (shardDir: string, s: IndexState, path: string): void => {
  s.dirty.add(path)
  if (s.flushScheduled) return
  s.flushScheduled = true
  Effect.runFork(Effect.sleep(FLUSH_DELAY).pipe(Effect.zipRight(flush(shardDir, s))))
}

// ─────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────

const refreshFile = async (
  shardDir: string,
  s: IndexState,
  path: string,
  format: TranscriptFormat
): Promise<Entry | null> => {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(path)
  } catch {
    if (s.entries.delete(path)) markDirty(shardDir, s, path)
    return null
  }

  if (!s.entries.has(path) && !s.probed.has(path)) {
    s.probed.add(path)
    const persisted = await loadShard(shardDir, path)
    if (persisted) s.entries.set(path, persisted)
  }

  const found = s.entries.get(path)
  const prev =
    found && found.format === format && found.v === TRANSCRIPT_INDEX_VERSION && found.ino === st.ino
      ? found
      : undefined
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev

  const fh = await open(path, "r")
  try {
    // Same size but touched again: nothing was appended, so the change is a rewrite.
    let rebuild = !prev || st.size < prev.offset || st.size === prev.size
    if (prev && !rebuild && prev.offset > 0 && (await readAnchor(fh, prev.offset)) !== prev.anchor) rebuild = true

    const next = !prev || rebuild ? emptyEntry(path, format, st.ino) : cloneEntry(prev)
    if (rebuild) s.rebuilds++
    const consumed = await forEachLine(fh, next.offset, st.size, (line) => {
      if (!foldLine(next, format, line)) next.skippedLines++
    })
    s.bytesParsed += consumed
    next.offset += consumed
    next.size = st.size
    next.mtimeMs = st.mtimeMs
    next.anchor = await readAnchor(fh, next.offset)
    s.entries.set(path, next)
    markDirty(shardDir, s, path)
    return next
  } finally {
    await fh.close()
  }
}

const snapshotImpl = (
  shardDir: string,
  s: IndexState,
  path: string,
  format: TranscriptFormat
): Effect.Effect<TranscriptSnapshot | null, never> =>
  withPathLock(
    s,
    path,
    s.readSem.withPermits(1)(
      Effect.tryPromise({
        try: () => refreshFile(shardDir, s, path, format),
        catch: (cause) => new FSError({ path, op: "read", cause }),
      })
    )
  ).pipe(
    Effect.map((e) => (e ? toSnapshot(e) : null)),
    Effect.catchAll((err) =>
      Effect.logWarning("transcript index: unreadable transcript").pipe(
        Effect.annotateLogs({ path: err.path }),
        Effect.as(null)
      )
    )
  )

// ─────────────────────────────────────────────────────────
// Codex catalog: rollout discovery + first-line (session_meta) view
// ─────────────────────────────────────────────────────────
//
// Each derived value is invalidated by a change in its own input:
//   - which rollouts exist  ← a directory's mtime (adding / removing a file changes it)
//   - a rollout's meta      ← its first line, immutable once written; re-read only when
//                             the inode changes (a replace) or no complete first line
//                             has been seen yet (a rollout still being created)
//   - recency (mtime/size)  ← a stat per listing

type CodexMeta = Omit<CodexSessionEntry, "path" | "modifiedAt" | "size">

interface CodexHead {
  ino: number
  meta: CodexMeta | null
}

const CODEX_HEADS_FILE = "codex-heads.json"
const CODEX_HEADS_VERSION = 2
const HEAD_MAX_BYTES = 1024 * 1024
const CODEX_STAT_CONCURRENCY = 16

/** The first complete line, or null while none has been written yet. */
const readFirstCompleteLine = async (path: string): Promise<string | null> => {
  const fh = await open(path, "r")
  try {
    const chunks: Buffer[] = []
    let pos = 0
    while (pos < HEAD_MAX_BYTES) {
      const buf = Buffer.alloc(Math.min(64 * 1024, HEAD_MAX_BYTES - pos))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead <= 0) return null
      const slice = buf.subarray(0, bytesRead)
      const nl = slice.indexOf(10)
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl))
        return Buffer.concat(chunks).toString("utf8")
      }
      chunks.push(slice)
      pos += bytesRead
    }
    return null
  } finally {
    await fh.close()
  }
}

/**
 * Canonical form of a path whether or not it still exists: realpath of its longest
 * existing ancestor, plus the rest. Plain realpath fails once a session's directory is
 * deleted (`/tmp/x` would then stay `/tmp/x` instead of `/private/tmp/x`), so the
 * result would depend on WHEN the rollout was first read.
 */
export const canonicalPath = async (p: string): Promise<string> => {
  let current = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return rest.length > 0 ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(p)
      rest.push(basename(current))
      current = parent
    }
  }
}

/** session_meta → catalog fields; null when the line is not a usable session_meta. */
export const parseCodexMetaLine = async (line: string): Promise<CodexMeta | null> => {
  let entry: { type?: string; payload?: Record<string, unknown> }
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const p = entry?.payload
  const id = p?.id
  const cwd = p?.cwd
  if (entry?.type !== "session_meta" || typeof id !== "string" || !id || typeof cwd !== "string" || !cwd) return null
  const cwdRealpath = await canonicalPath(cwd)
  // Present only on a sub-agent rollout (codex `spawn_agent`) — the only way to tell
  // one from a session the user started.
  const parent = typeof p.parent_thread_id === "string" ? p.parent_thread_id : ""
  const isSubagent = p.thread_source === "subagent" || !!parent
  return {
    id,
    cwd,
    cwdRealpath,
    ...(isSubagent
      ? {
          parentThreadId: parent,
          ...(typeof p.agent_role === "string" && p.agent_role ? { agentRole: p.agent_role } : {}),
          ...(typeof p.agent_nickname === "string" && p.agent_nickname ? { agentNickname: p.agent_nickname } : {}),
        }
      : {}),
  }
}

const loadCodexHeads = (shardDir: string, s: IndexState): Promise<void> =>
  (s.codexHeadsLoad ??= (async () => {
    const persisted = await readFile(join(shardDir, CODEX_HEADS_FILE), "utf8")
      .then((raw) => JSON.parse(raw) as { v?: number; heads?: Record<string, CodexHead> })
      .catch(() => null)
    // Our own file, versioned like the shards: anything else (another version, a
    // malformed entry) is dropped and its rollout's first line read again.
    if (persisted?.v !== CODEX_HEADS_VERSION || !persisted.heads || typeof persisted.heads !== "object") return
    for (const [path, head] of Object.entries(persisted.heads)) {
      if (typeof head?.ino !== "number") continue
      const meta = head.meta
      if (meta !== null && (typeof meta?.id !== "string" || typeof meta.cwd !== "string")) continue
      s.codexHeads.set(path, { ino: head.ino, meta })
    }
  })())

const flushCodexHeads = (shardDir: string, s: IndexState): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    s.codexHeadsFlushScheduled = false
    if (!s.codexHeadsDirty) return
    s.codexHeadsDirty = false
    const file = join(shardDir, CODEX_HEADS_FILE)
    const text = JSON.stringify({ v: CODEX_HEADS_VERSION, heads: Object.fromEntries(s.codexHeads) })
    yield* Effect.tryPromise({
      try: () => writeAtomically(file, text),
      catch: (cause) => new FSError({ path: file, op: "write", cause }),
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          s.codexHeadsDirty = true
        }).pipe(Effect.zipRight(Effect.logWarning("transcript index: codex heads write failed").pipe(Effect.annotateLogs({ path: err.path }))))
      )
    )
  })

const markCodexHeadsDirty = (shardDir: string, s: IndexState): void => {
  s.codexById = null
  s.codexHeadsDirty = true
  if (s.codexHeadsFlushScheduled) return
  s.codexHeadsFlushScheduled = true
  Effect.runFork(Effect.sleep(FLUSH_DELAY).pipe(Effect.zipRight(flushCodexHeads(shardDir, s))))
}

/** Every rollout path; concurrent callers share one walk (single-flight). */
const listCodexRollouts = (s: IndexState): Promise<string[]> =>
  (s.codexWalkInflight ??= walkCodexRollouts(s).finally(() => {
    s.codexWalkInflight = null
  }))

/** A directory whose mtime is unchanged is not re-listed. */
const walkCodexRollouts = async (s: IndexState): Promise<string[]> => {
  const out: string[] = []
  const stack = [CODEX_SESSIONS_DIR]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const mtimeMs = await stat(dir).then((st) => st.mtimeMs, () => null)
    if (mtimeMs === null) {
      s.codexDirs.delete(dir)
      continue
    }
    let listing = s.codexDirs.get(dir)
    if (!listing || listing.mtimeMs !== mtimeMs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
      if (!entries) continue
      listing = {
        mtimeMs,
        dirs: entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name)),
        files: entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(dir, e.name)),
      }
      s.codexDirs.set(dir, listing)
    }
    out.push(...listing.files)
    stack.push(...listing.dirs)
  }
  return out
}

/** The rollout's meta, reading its first line only when the cached view is not valid. */
const codexHeadFor = async (shardDir: string, s: IndexState, path: string, ino: number): Promise<CodexMeta | null> => {
  // Only a meta this catalog read itself, from this very inode, is trusted.
  const head = s.codexHeads.get(path)
  if (head?.meta && head.ino === ino) return head.meta
  // Single-flight: on a cold start dozens of lookups miss at once and would each read
  // every rollout's first line (61 misses × 1,282 rollouts = 77k reads, measured).
  const inflight = s.codexHeadInflight.get(path)
  if (inflight) return inflight
  const read = (async () => {
    s.codexHeadReads++
    const line = await readFirstCompleteLine(path).catch(() => null)
    const meta = line ? await parseCodexMetaLine(line) : null
    s.codexHeads.set(path, { ino, meta })
    markCodexHeadsDirty(shardDir, s)
    return meta
  })().finally(() => s.codexHeadInflight.delete(path))
  s.codexHeadInflight.set(path, read)
  return read
}

const codexEntry = async (shardDir: string, s: IndexState, path: string): Promise<CodexSessionEntry | null> => {
  const st = await stat(path).catch(() => null)
  if (!st) {
    if (s.codexHeads.delete(path)) markCodexHeadsDirty(shardDir, s)
    return null
  }
  const meta = await codexHeadFor(shardDir, s, path, st.ino)
  return meta ? { ...meta, path, modifiedAt: st.mtimeMs, size: st.size } : null
}

const codexSessionsImpl = (shardDir: string, s: IndexState): Effect.Effect<ReadonlyArray<CodexSessionEntry>, never> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => loadCodexHeads(shardDir, s))
    const files = yield* Effect.promise(() => listCodexRollouts(s))
    const live = new Set(files)
    for (const path of s.codexHeads.keys()) {
      if (!live.has(path)) {
        s.codexHeads.delete(path)
        markCodexHeadsDirty(shardDir, s)
      }
    }
    const entries = yield* Effect.forEach(files, (path) => Effect.promise(() => codexEntry(shardDir, s, path)), {
      concurrency: CODEX_STAT_CONCURRENCY,
    })
    return entries.filter((e): e is CodexSessionEntry => e !== null).sort((a, b) => b.modifiedAt - a.modifiedAt)
  })

const codexPathsById = (s: IndexState, id: string): string[] => {
  if (!s.codexById) {
    const byId = new Map<string, string[]>()
    for (const [path, head] of s.codexHeads) {
      if (!head.meta) continue
      const list = byId.get(head.meta.id)
      if (list) list.push(path)
      else byId.set(head.meta.id, [path])
    }
    s.codexById = byId
  }
  return s.codexById.get(id) ?? []
}

const resolveCodexImpl = (
  shardDir: string,
  s: IndexState,
  threadId: string
): Effect.Effect<CodexSessionEntry | null, never> =>
  Effect.gen(function* () {
    const id = normalizeCodexSessionId(threadId)
    yield* Effect.promise(() => loadCodexHeads(shardDir, s))
    const fromKnown = async (): Promise<CodexSessionEntry | null> => {
      for (const path of codexPathsById(s, id)) {
        const entry = await codexEntry(shardDir, s, path)
        if (entry?.id === id) return entry
      }
      return null
    }
    const known = yield* Effect.promise(fromKnown)
    if (known) return known
    // Miss: only rollouts not yet known (or whose first line was still incomplete) can
    // hold it; unchanged directories cost one stat each.
    const files = yield* Effect.promise(() => listCodexRollouts(s))
    const pending = files.filter((f) => !s.codexHeads.get(f)?.meta)
    yield* Effect.forEach(pending, (path) => Effect.promise(() => codexEntry(shardDir, s, path)), {
      concurrency: CODEX_STAT_CONCURRENCY,
      discard: true,
    })
    return yield* Effect.promise(fromKnown)
  })

/**
 * Drop a file's folded state (in every index this process holds) and its shard. Called
 * by transcriptWrite.ts after Cockpit rewrites a transcript, so the next read rebuilds
 * even if it lands before the new inode would have been noticed.
 */
export const invalidateTranscript = (path: string): void => {
  for (const [shardDir, s] of states) {
    // Mark it probed so the (equally stale) shard is never loaded back; the flush
    // finds no entry for a dirty path and removes the shard.
    s.probed.add(path)
    s.entries.delete(path)
    markDirty(shardDir, s, path)
    if (s.codexHeads.delete(path)) markCodexHeadsDirty(shardDir, s)
  }
}

// ─────────────────────────────────────────────────────────
// Layer
// ─────────────────────────────────────────────────────────

export const TranscriptIndexLive = Layer.effect(
  TranscriptIndex,
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const shardDir = join(cfg.cockpitDir, "transcript-index")
    const s = stateFor(shardDir)
    return TranscriptIndex.of({
      snapshot: (path, format) =>
        snapshotImpl(shardDir, s, path, format).pipe(Effect.withSpan("transcriptIndex.snapshot")),
      snapshots: (files) =>
        Effect.forEach(files, (f) => snapshotImpl(shardDir, s, f.path, f.format), {
          concurrency: READ_CONCURRENCY * 2,
        }).pipe(Effect.withSpan("transcriptIndex.snapshots")),
      codexSessions: codexSessionsImpl(shardDir, s).pipe(Effect.withSpan("transcriptIndex.codexSessions")),
      resolveCodex: (threadId) =>
        resolveCodexImpl(shardDir, s, threadId).pipe(Effect.withSpan("transcriptIndex.resolveCodex")),
      invalidate: (path) => Effect.sync(() => invalidateTranscript(path)),
      counters: Effect.sync(
        (): TranscriptIndexCounters => ({ bytesParsed: s.bytesParsed, rebuilds: s.rebuilds, codexHeadReads: s.codexHeadReads })
      ),
    })
  })
)

/**
 * Promise bridge for the plain-async server modules (globalState.ts and the engines
 * that call it). The Layer is cheap to provide per call: its state is the pinned
 * process-wide index, not something the Layer builds.
 */
export const runWithTranscriptIndex = <A>(
  f: (index: TranscriptIndex) => Effect.Effect<A, never>
): Promise<A> => Effect.runPromise(Effect.flatMap(TranscriptIndex, f).pipe(Effect.provide(TranscriptIndexLive)))

/** Promise bridge: the rollout for a codex thread id, or null. */
export const findCodexSession = (threadId: string): Promise<CodexSessionEntry | null> =>
  runWithTranscriptIndex((index) => index.resolveCodex(threadId))

/** Promise bridge: every codex rollout (sub-agents included), newest first. */
export const listCodexSessionEntries = (): Promise<ReadonlyArray<CodexSessionEntry>> =>
  runWithTranscriptIndex((index) => index.codexSessions)

/** Effect form of listCodexSessionEntries for Live layers built outside AppLayer's graph. */
export const codexSessionEntries: Effect.Effect<ReadonlyArray<CodexSessionEntry>, never> = Effect.flatMap(
  TranscriptIndex,
  (index) => index.codexSessions
).pipe(Effect.provide(TranscriptIndexLive))

/** Effect form of `snapshot` for Live layers built outside AppLayer's graph. */
export const transcriptSnapshot = (
  path: string,
  format: TranscriptFormat
): Effect.Effect<TranscriptSnapshot | null, never> =>
  Effect.flatMap(TranscriptIndex, (index) => index.snapshot(path, format)).pipe(Effect.provide(TranscriptIndexLive))
