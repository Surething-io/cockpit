/**
 * SessionSearchServiceLive — derived-text corpus + ripgrep.
 *
 * Why a corpus: raw transcripts are dominated by tool output, system reminders and
 * base64 images (measured: 668 MB of claude jsonl → 12 MB of prompt/reply text).
 * Why ripgrep, not SQLite FTS5: FTS5 cannot match 2-character Chinese words
 * (unicode61 does not segment CJK; trigram needs ≥3 chars). ripgrep over the small
 * corpus matches any substring in milliseconds.
 *
 * Layout:    <cockpitDir>/search-corpus/<engine>/<sessionId>.txt + manifest.v2.json
 * Source:    corpus text is rendered from the TranscriptIndex snapshot (prompts and
 *            replies it has already folded) — this layer never parses a transcript.
 * Freshness: a session is re-rendered when its source mtime+size fingerprint changes,
 *            or when its project directory was unknown and has since become resolvable
 *            (the directory lookup draws on projects.json / state.json / other
 *            transcripts, none of which change the source fingerprint).
 *            A corpus file whose source is gone is deleted.
 * Scope:     top-level sessions only — claude `agent-*.jsonl` sidechains, subagent
 *            directories and codex sub-agent rollouts are excluded.
 * Concurrency: syncs are serialised by a semaphore owned by this layer.
 */
import { execFile } from "node:child_process"
import { mkdir, open, readdir, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Effect, Either, Layer } from "effect"
import { rgPath } from "@vscode/ripgrep"
import { AppError, CockpitConfig, FSError, type FSOp } from "@cockpit/effect-core"
import { readJsonOr, writeAtomically } from "@cockpit/effect-runtime/server/fs"
import {
  SessionSearchService,
  type CorpusSyncStats,
  type SessionSearchHit,
  type SessionSearchQuery,
} from "@cockpit/effect-services"
import {
  CLAUDE_PROJECTS_DIR,
  GLOBAL_STATE_FILE,
  getBuiltinSessionsRoot,
} from "@cockpit/shared-utils"
import { encodePath } from "@cockpit/shared-utils/encodePath"
import { buildSessionLink } from "@cockpit/shared-utils/sessionLink"
import { generateTitle } from "../server/sessionTitle"
import { isCodexSubagent, listMessages, titleMessages } from "../server/transcriptViews"
import { codexSessionEntries, transcriptSnapshot } from "./transcriptIndexLive"

// ─────────────────────────────────────────────────────────
// Corpus format (pure)
// ─────────────────────────────────────────────────────────

export const CORPUS_MAGIC = "#cockpit-corpus v1"
export const HEADER_END = "#---"
/** renderCorpusText writes a fixed header: magic, engine, sessionId, cwd, title, updatedAt, HEADER_END. */
export const CORPUS_HEADER_LINES = 7
export const CORPUS_TITLE_LINE = 5

const BUILTIN_ENGINES = ["ollama", "deepseek", "kimi", "glm"] as const
const MANIFEST_FILE = "manifest.v2.json"
const LEGACY_MANIFEST_FILE = "manifest.json"
const PARSE_CONCURRENCY = 4
const HEADER_PROBE_BYTES = 8192
const SNIPPETS_PER_HIT = 3
const SNIPPET_RADIUS = 120
/** Permits of the corpus readers-writer lock: a sync takes all of them, a search takes one. */
const CORPUS_LOCK_PERMITS = 16

export interface CorpusMeta {
  readonly engine: string
  readonly sessionId: string
  readonly cwd: string | null
  readonly title: string
  readonly updatedAt: number
}

export interface CorpusSource {
  readonly engine: string
  readonly sessionId: string
  readonly sourcePath: string
  /** Known up front for codex (its index carries it); resolved later for the rest. */
  readonly cwd: string | null
  /** Encoded-cwd directory name for cwd-sharded stores (claude, built-in engines). */
  readonly encodedDir: string | null
}

interface ManifestEntry {
  readonly fingerprint: string
  /** '' = parsed but held no searchable text (kept so it is not re-parsed). */
  readonly corpusPath: string
  /** Project directory the corpus header was written with; null = unknown. */
  readonly cwd: string | null
}
type Manifest = Record<string, ManifestEntry>

export const renderCorpusText = (
  meta: CorpusMeta,
  messages: ReadonlyArray<{ role: string; content: string }>
): string => {
  const oneLine = (v: string) => v.replace(/\s+/g, " ").trim()
  const header = [
    CORPUS_MAGIC,
    `#engine: ${meta.engine}`,
    `#sessionId: ${meta.sessionId}`,
    `#cwd: ${meta.cwd ?? ""}`,
    `#title: ${oneLine(meta.title)}`,
    `#updatedAt: ${Math.floor(meta.updatedAt)}`,
    HEADER_END,
  ]
  const body = messages.map((m) => `${m.role === "user" ? "U" : "A"}: ${m.content.trim()}`)
  return `${header.join("\n")}\n${body.join("\n")}\n`
}

export const parseCorpusHeader = (text: string): CorpusMeta | null => {
  const lines = text.split("\n")
  if (lines[0] !== CORPUS_MAGIC) return null
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, CORPUS_HEADER_LINES)) {
    if (line === HEADER_END) break
    const m = line.match(/^#(\w+): ?(.*)$/)
    if (m) fields[m[1]] = m[2]
  }
  if (!fields.engine || !fields.sessionId) return null
  return {
    engine: fields.engine,
    sessionId: fields.sessionId,
    cwd: fields.cwd || null,
    title: fields.title ?? "",
    updatedAt: Number(fields.updatedAt) || 0,
  }
}

// ─────────────────────────────────────────────────────────
// ripgrep output (pure)
// ─────────────────────────────────────────────────────────

export interface RgLineMatch {
  readonly file: string
  readonly line: string
  /** 1-based; tells header lines apart from message lines that merely start with '#'. */
  readonly lineNumber: number
}

export const parseRgJson = (stdout: string): RgLineMatch[] =>
  stdout.split("\n").flatMap((raw): RgLineMatch[] => {
    if (!raw.startsWith('{"type":"match"')) return []
    const parsed = Either.try(
      () =>
        JSON.parse(raw) as {
          data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
        }
    )
    if (Either.isLeft(parsed)) return []
    const d = parsed.right.data
    const file = d?.path?.text
    const text = d?.lines?.text
    const lineNumber = d?.line_number
    if (!file || typeof text !== "string" || typeof lineNumber !== "number") return []
    return [{ file, line: text.replace(/\n$/, ""), lineNumber }]
  })

const snippetAround = (line: string, terms: ReadonlyArray<string>): string => {
  const lower = line.toLowerCase()
  const at =
    terms
      .map((t) => lower.indexOf(t.toLowerCase()))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(line.length, at + SNIPPET_RADIUS)
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`
}

export interface GroupedMatch {
  matchCount: number
  readonly matchedTerms: Set<string>
  readonly snippets: string[]
}

export const groupMatches = (
  matches: ReadonlyArray<RgLineMatch>,
  terms: ReadonlyArray<string>
): Map<string, GroupedMatch> => {
  const byFile = new Map<string, GroupedMatch>()
  for (const { file, line, lineNumber } of matches) {
    // Header fields other than the title are addressing metadata. Decided by position,
    // not by a leading '#': markdown headings inside a reply start with '#' too.
    if (lineNumber <= CORPUS_HEADER_LINES && lineNumber !== CORPUS_TITLE_LINE) continue
    const lower = line.toLowerCase()
    const hitTerms = terms.filter((t) => lower.includes(t.toLowerCase()))
    if (hitTerms.length === 0) continue
    const entry = byFile.get(file) ?? { matchCount: 0, matchedTerms: new Set<string>(), snippets: [] }
    entry.matchCount++
    hitTerms.forEach((t) => entry.matchedTerms.add(t))
    if (entry.snippets.length < SNIPPETS_PER_HIT) entry.snippets.push(snippetAround(line, hitTerms))
    byFile.set(file, entry)
  }
  return byFile
}

// ─────────────────────────────────────────────────────────
// Filesystem IO
// ─────────────────────────────────────────────────────────

const fsTry = <A>(
  path: string,
  op: FSOp,
  fn: () => Promise<A>
): Effect.Effect<A, FSError> =>
  Effect.tryPromise({ try: fn, catch: (cause) => new FSError({ path, op, cause }) })

/** First `bytes` of a file as UTF-8; the handle is always closed. */
const readHead = (file: string, bytes: number): Effect.Effect<string, FSError> =>
  Effect.acquireUseRelease(
    fsTry(file, "read", () => open(file, "r")),
    (fh) =>
      fsTry(file, "read", async () => {
        const buf = Buffer.alloc(bytes)
        const { bytesRead } = await fh.read(buf, 0, bytes, 0)
        return buf.subarray(0, bytesRead).toString("utf-8")
      }),
    (fh) => Effect.tryPromise(() => fh.close()).pipe(Effect.ignore)
  )

const listSubdirs = (root: string): Effect.Effect<string[], never> =>
  fsTry(root, "read", () => readdir(root, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((d) => d.isDirectory()).map((d) => d.name)),
    Effect.orElseSucceed(() => [] as string[])
  )

const listTopLevelTranscripts = (dir: string): Effect.Effect<string[], never> =>
  fsTry(dir, "read", () => readdir(dir)).pipe(
    Effect.map((files) => files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))),
    Effect.orElseSucceed(() => [] as string[])
  )

export const listCorpusSources: Effect.Effect<CorpusSource[], never> = Effect.gen(function* () {
  const out: CorpusSource[] = []
  const fromShardedStore = (engine: string, root: string): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      for (const encodedDir of yield* listSubdirs(root)) {
        for (const file of yield* listTopLevelTranscripts(join(root, encodedDir))) {
          out.push({
            engine,
            sessionId: file.slice(0, -".jsonl".length),
            sourcePath: join(root, encodedDir, file),
            cwd: null,
            encodedDir,
          })
        }
      }
    })

  yield* fromShardedStore("claude", CLAUDE_PROJECTS_DIR)
  for (const engine of BUILTIN_ENGINES) {
    yield* fromShardedStore(engine, getBuiltinSessionsRoot(engine))
  }
  // Sub-agent rollouts are out of scope (see header), as in every session list.
  const codex = (yield* codexSessionEntries).filter((entry) => !isCodexSubagent(entry))
  for (const entry of codex) {
    out.push({ engine: "codex", sessionId: entry.id, sourcePath: entry.path, cwd: entry.cwd || null, encodedDir: null })
  }
  return out
})

/** The first `cwd` field of a claude transcript, from the transcript index. */
const firstCwdInTranscript = (file: string): Effect.Effect<string | null, never> =>
  transcriptSnapshot(file, "claude").pipe(Effect.map((snap) => snap?.cwd ?? null))

/**
 * encodedDir → cwd, for stores whose transcripts carry no cwd. Encoding is not
 * reversible, so every cwd we know about is encoded and matched on the result.
 */
const buildCwdLookup = (
  cockpitDir: string,
  knownCwds: ReadonlyArray<string>
): Effect.Effect<Map<string, string>, never> =>
  Effect.gen(function* () {
    const lookup = new Map<string, string>()
    const add = (cwd: unknown) => {
      if (typeof cwd === "string" && cwd) lookup.set(encodePath(cwd), cwd)
    }
    const projects = yield* readJsonOr<{ projects?: Array<{ cwd?: string }> }>(join(cockpitDir, "projects.json"), {})
    const state = yield* readJsonOr<{ sessions?: Array<{ cwd?: string }> }>(GLOBAL_STATE_FILE, {})
    for (const p of projects.projects ?? []) add(p.cwd)
    for (const s of state.sessions ?? []) add(s.cwd)
    for (const cwd of knownCwds) add(cwd)
    return lookup
  })

/** Cheap resolution from already-known facts: no transcript reads. */
const knownCwd = (source: CorpusSource, lookup: Map<string, string>): string | null =>
  source.cwd ?? (source.encodedDir ? lookup.get(source.encodedDir) ?? null : null)

/** Full resolution: may read transcript heads. */
const resolveCwd = (
  source: CorpusSource,
  lookup: Map<string, string>
): Effect.Effect<string | null, never> =>
  Effect.gen(function* () {
    if (source.cwd) return source.cwd
    if (source.engine === "claude") {
      const fromFile = yield* firstCwdInTranscript(source.sourcePath)
      if (fromFile) {
        if (source.encodedDir) lookup.set(source.encodedDir, fromFile)
        return fromFile
      }
    }
    const known = knownCwd(source, lookup)
    if (known || !source.encodedDir) return known
    // A built-in engine session in a project that also has claude sessions.
    const claudeDir = join(CLAUDE_PROJECTS_DIR, source.encodedDir)
    for (const file of yield* listTopLevelTranscripts(claudeDir)) {
      const cwd = yield* firstCwdInTranscript(join(claudeDir, file))
      if (cwd) {
        // Reuse for the other sessions sharing this encoded directory.
        lookup.set(source.encodedDir, cwd)
        return cwd
      }
    }
    return null
  })

/**
 * Corpus text for one session, rendered from the transcript index: the prompts and
 * replies it has already folded (only bytes appended since its last read are parsed).
 * The corpus is searchable text, not a chat rendering — every user prompt and assistant
 * text block, line by line, with no display-layer merging or de-duplication.
 */
const extractText = (
  source: CorpusSource,
  cwd: string | null,
  updatedAt: number
): Effect.Effect<string | null, AppError> =>
  Effect.gen(function* () {
    const format = source.engine === "codex" ? "codex" : "claude"
    const snap = yield* transcriptSnapshot(source.sourcePath, format)
    if (!snap) {
      return yield* Effect.fail(new AppError({ message: `failed to read transcript ${source.sourcePath}` }))
    }
    if (snap.corpus.length === 0) return null
    const title =
      format === "codex"
        ? listMessages(snap)[0]?.slice(0, 80) || "Untitled Session"
        : generateTitle(snap.aiTitle, snap.summary, titleMessages(snap))
    return renderCorpusText(
      { engine: source.engine, sessionId: source.sessionId, cwd, title, updatedAt },
      snap.corpus.map((line) => ({ role: line.role, content: line.text }))
    )
  })

// ─────────────────────────────────────────────────────────
// Sync
// ─────────────────────────────────────────────────────────

interface Planned {
  readonly source: CorpusSource
  readonly fingerprint: string
  readonly corpusPath: string
  readonly mtimeMs: number
  /** Already resolved during planning; undefined = resolve during the rebuild. */
  readonly cwd: string | null | undefined
}

const syncImpl = (cockpitDir: string, corpusDir: string): Effect.Effect<CorpusSyncStats, FSError> =>
  Effect.gen(function* () {
    // v2: corpus text is rendered from the transcript index. A v1 manifest (text from
    // the display parser) is only consulted to delete corpus files whose source is gone;
    // every source is re-rendered once.
    const manifestFile = join(corpusDir, MANIFEST_FILE)
    const legacyManifestFile = join(corpusDir, LEGACY_MANIFEST_FILE)
    yield* fsTry(corpusDir, "mkdir", () => mkdir(corpusDir, { recursive: true }))
    const previous = yield* readJsonOr<Manifest>(manifestFile, {})
    const legacy = yield* readJsonOr<Manifest>(legacyManifestFile, {})
    const sources = yield* listCorpusSources
    const lookup = yield* buildCwdLookup(
      cockpitDir,
      sources.flatMap((s) => (s.cwd ? [s.cwd] : []))
    )

    const next: Manifest = {}
    const planned: Planned[] = []
    for (const source of sources) {
      const st = yield* fsTry(source.sourcePath, "stat", () => stat(source.sourcePath)).pipe(Effect.option)
      if (st._tag === "None") continue
      const fingerprint = `${Math.floor(st.value.mtimeMs)}-${st.value.size}`
      const corpusPath = join(corpusDir, source.engine, `${source.sessionId}.txt`)
      const prev = previous[source.sourcePath]
      const unchanged = prev !== undefined && prev.fingerprint === fingerprint
      const corpusPresent =
        prev !== undefined &&
        (prev.corpusPath === "" ||
          (yield* fsTry(prev.corpusPath, "stat", () => stat(prev.corpusPath)).pipe(Effect.option))._tag === "Some")
      if (unchanged && corpusPresent) {
        const prevCwd = prev.cwd ?? null
        // An unknown project directory may have become resolvable without this source's
        // fingerprint changing (a newly registered project, or a claude transcript appearing
        // in the same encoded dir). Use the full resolution — the same one a rebuild uses —
        // so every source of evidence counts.
        const resolved = prevCwd === null ? yield* resolveCwd(source, lookup) : prevCwd
        if (resolved === prevCwd) {
          next[source.sourcePath] = { fingerprint, corpusPath: prev.corpusPath, cwd: prevCwd }
          continue
        }
        planned.push({ source, fingerprint, corpusPath, mtimeMs: st.value.mtimeMs, cwd: resolved })
        continue
      }
      planned.push({ source, fingerprint, corpusPath, mtimeMs: st.value.mtimeMs, cwd: undefined })
    }

    const rebuilt = yield* Effect.forEach(
      planned,
      ({ source, fingerprint, corpusPath, mtimeMs, cwd: plannedCwd }): Effect.Effect<readonly [string, ManifestEntry | null], never> =>
        Effect.gen(function* () {
          const cwd = plannedCwd !== undefined ? plannedCwd : yield* resolveCwd(source, lookup)
          const extracted = yield* Effect.either(extractText(source, cwd, mtimeMs))
          if (Either.isLeft(extracted)) {
            // A read failure is NOT "no searchable text": keep whatever was indexed before
            // (old corpus file, old fingerprint), so the next sync sees a mismatch and retries.
            yield* Effect.logWarning("session search: unreadable transcript, will retry").pipe(
              Effect.annotateLogs({ path: source.sourcePath, error: extracted.left.message })
            )
            const kept: readonly [string, ManifestEntry | null] = [source.sourcePath, previous[source.sourcePath] ?? null]
            return kept
          }
          const text = extracted.right
          const written: Effect.Effect<ManifestEntry, FSError> = text
            ? fsTry(corpusPath, "write", () => writeAtomically(corpusPath, text)).pipe(
                Effect.as({ fingerprint, corpusPath, cwd })
              )
            : fsTry(corpusPath, "rm", () => rm(corpusPath, { force: true })).pipe(
                Effect.as({ fingerprint, corpusPath: "", cwd })
              )
          // A write failure leaves the source out of the manifest, so the next sync retries it.
          const entry = yield* written.pipe(
            Effect.catchAll((e) =>
              Effect.logWarning("session search: failed to write corpus file").pipe(
                Effect.annotateLogs({ path: e.path }),
                Effect.as(null)
              )
            )
          )
          const result: readonly [string, ManifestEntry | null] = [source.sourcePath, entry]
          return result
        }),
      { concurrency: PARSE_CONCURRENCY }
    )
    for (const [sourcePath, entry] of rebuilt) {
      if (entry) next[sourcePath] = entry
    }

    let removed = 0
    for (const [sourcePath, entry] of [...Object.entries(legacy), ...Object.entries(previous)]) {
      if (next[sourcePath] !== undefined || rebuilt.some(([p]) => p === sourcePath)) continue
      if (entry.corpusPath) {
        yield* fsTry(entry.corpusPath, "rm", () => rm(entry.corpusPath, { force: true })).pipe(Effect.ignore)
      }
      removed++
    }

    yield* fsTry(manifestFile, "write", () => writeAtomically(manifestFile, JSON.stringify(next)))
    if (Object.keys(legacy).length > 0) {
      yield* fsTry(legacyManifestFile, "rm", () => rm(legacyManifestFile, { force: true })).pipe(Effect.ignore)
    }
    return {
      sources: sources.length,
      indexed: Object.values(next).filter((e) => e.corpusPath).length,
      rebuilt: rebuilt.length,
      removed,
    }
  })

// ─────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────

const runRipgrep = (corpusDir: string, terms: ReadonlyArray<string>): Effect.Effect<string, AppError> =>
  Effect.async<string, AppError>((resume) => {
    const args = [
      "--json",
      "--ignore-case",
      "--fixed-strings",
      "--max-count", "50",
      "--glob", "*.txt",
      ...terms.flatMap((t) => ["-e", t]),
      corpusDir,
    ]
    const child = execFile(rgPath, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      // Exit code 1 = no matches: not an error.
      if (err && (err as { code?: unknown }).code !== 1) {
        resume(Effect.fail(new AppError({ message: "ripgrep failed", cause: err })))
      } else {
        resume(Effect.succeed(stdout ?? ""))
      }
    })
    // Interrupting the fiber (client gone) stops the search process.
    return Effect.sync(() => {
      child.kill()
    })
  })

const readCorpusHeader = (corpusPath: string): Effect.Effect<CorpusMeta | null, never> =>
  readHead(corpusPath, HEADER_PROBE_BYTES).pipe(
    Effect.map(parseCorpusHeader),
    Effect.orElseSucceed(() => null)
  )

const searchImpl = (
  corpusDir: string,
  query: SessionSearchQuery
): Effect.Effect<ReadonlyArray<SessionSearchHit>, AppError> =>
  Effect.gen(function* () {
    const grouped = groupMatches(parseRgJson(yield* runRipgrep(corpusDir, query.terms)), query.terms)
    const cwdPrefix = query.cwd ? query.cwd.replace(/\/+$/, "") : undefined
    const hits: SessionSearchHit[] = []
    for (const [file, g] of grouped) {
      const meta = yield* readCorpusHeader(resolve(file))
      if (!meta) continue
      if (cwdPrefix && !(meta.cwd === cwdPrefix || meta.cwd?.startsWith(`${cwdPrefix}/`))) continue
      if (query.since !== undefined && meta.updatedAt < query.since) continue
      hits.push({
        ...meta,
        link: meta.cwd ? buildSessionLink(meta.cwd, meta.sessionId) : null,
        matchCount: g.matchCount,
        matchedTerms: [...g.matchedTerms],
        snippets: g.snippets,
      })
    }
    hits.sort(
      (a, b) =>
        b.matchedTerms.length - a.matchedTerms.length ||
        b.matchCount - a.matchCount ||
        b.updatedAt - a.updatedAt
    )
    return hits.slice(0, query.limit)
  })

// ─────────────────────────────────────────────────────────
// Layer
// ─────────────────────────────────────────────────────────

export const SessionSearchServiceLive = Layer.effect(
  SessionSearchService,
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const corpusDir = join(cfg.cockpitDir, "search-corpus")
    // Readers-writer lock over the corpus: a sync takes every permit, a search takes one.
    // Searches run together but never overlap a sync, so the rg pass and the header reads
    // that follow it see one generation of the corpus.
    const corpusLock = yield* Effect.makeSemaphore(CORPUS_LOCK_PERMITS)
    return SessionSearchService.of({
      sync: corpusLock
        .withPermits(CORPUS_LOCK_PERMITS)(syncImpl(cfg.cockpitDir, corpusDir))
        .pipe(Effect.withSpan("sessionSearch.sync")),
      search: (query: SessionSearchQuery) =>
        corpusLock.withPermits(1)(searchImpl(corpusDir, query)).pipe(Effect.withSpan("sessionSearch.search")),
    })
  })
)
