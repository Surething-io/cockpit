// Scoped retention for native Pi sessions. Claude and Codex retain their own stores;
// only Cockpit's own per-session Claude context snapshots are swept beside them.
import { readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Schedule } from "effect"
import { AppError, CockpitConfig } from "@cockpit/effect-core"
import { readPiManager } from "./piSessionLive"
import { beginTranscriptEdit } from "../server/sessionRunHub"
import { cleanupOrphanedContextUsage } from "../server/context/claudeContextStore"
import { CLAUDE_PROJECTS_DIR } from "@cockpit/shared-utils"

const DAY_MS = 24 * 3600 * 1000

const fsTry = <A>(op: string, fn: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new AppError({ message: `session cleanup fs ${op} failed`, cause }),
  })

const isDirectory = (p: string): Effect.Effect<boolean, never> =>
  fsTry("stat", () => stat(p).then((s) => s.isDirectory())).pipe(
    Effect.orElseSucceed(() => false)
  )

/**
 * Load the pinned-session id whitelist. Distinguishes three cases:
 *  - missing file  -> `{ ok: true, ids: {} }` (no pins, cleanup proceeds)
 *  - readable JSON -> `{ ok: true, ids }`
 *  - corrupt/unreadable -> `{ ok: false }` (caller SKIPS the whole pass)
 */
type PinLoad = { ok: true; ids: Set<string> } | { ok: false }

const loadPinnedIds = (pinnedFile: string): Effect.Effect<PinLoad, never> =>
  Effect.tryPromise({
    try: async (): Promise<PinLoad> => {
      let raw: string
      try {
        raw = await readFile(pinnedFile, "utf8")
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          return { ok: true, ids: new Set<string>() }
        }
        throw e
      }
      const parsed = JSON.parse(raw) as ReadonlyArray<{ sessionId?: unknown }>
      const ids = new Set<string>()
      for (const p of Array.isArray(parsed) ? parsed : []) {
        if (p && typeof p.sessionId === "string") ids.add(p.sessionId)
      }
      return { ok: true, ids }
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => ({ ok: false }) as PinLoad))

export const cleanupSessions = (
  root: string,
  keepDays: number,
  pinnedFile: string
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const pins = yield* loadPinnedIds(pinnedFile)
    if (!pins.ok) {
      yield* Effect.logWarning(
        "session cleanup: pinned-sessions.json is unreadable/corrupt -- skipping this pass (refusing to risk deleting protected sessions)"
      )
      return
    }

    const cutoff = Date.now() - keepDays * DAY_MS
    const cwdDirs = yield* fsTry("readdir root", () => readdir(root)).pipe(
      Effect.orElseSucceed(() => [] as string[])
    )

    for (const cwdName of cwdDirs) {
      const cwdDir = join(root, cwdName)
      if (!(yield* isDirectory(cwdDir))) continue

      const entries = yield* fsTry("readdir cwd", () => readdir(cwdDir)).pipe(
        Effect.orElseSucceed(() => [] as string[])
      )

      // Native Pi filenames include a timestamp; attachments are keyed by the
      // header's session ID. Group both before considering orphan directories.
      const sessions = new Map<string, { jsonl?: string; subdir?: string }>()
      for (const name of entries) {
        const full = join(cwdDir, name)
        if (!name.endsWith(".jsonl")) continue
        const sessionId = yield* readPiManager(full).pipe(Effect.map((manager) => manager.getSessionId()))
        sessions.set(sessionId, { ...sessions.get(sessionId), jsonl: full })
      }
      for (const name of entries) {
        const full = join(cwdDir, name)
        if (yield* isDirectory(full)) sessions.set(name, { ...sessions.get(name), subdir: full })
      }

      for (const [sessionId, s] of sessions) {
        if (pins.ids.has(sessionId)) continue // pinned -> never auto-delete

        // Basis = parent transcript mtime (last activity). Fall back to the
        // attachment dir only for an orphan `<id>/` with no `.jsonl`.
        const basis = s.jsonl ?? s.subdir
        if (!basis) continue
        const mtime = yield* fsTry("stat basis", () =>
          stat(basis).then((st) => st.mtimeMs)
        ).pipe(Effect.orElseSucceed(() => Number.POSITIVE_INFINITY)) // stat fail -> keep
        if (mtime >= cutoff) continue // still fresh -> keep whole session

        const endEdit = yield* Effect.sync(() => beginTranscriptEdit(sessionId))
        if (!endEdit) continue
        yield* Effect.gen(function* () {
          // Candidate information can be stale: recheck protection and activity
          // after taking the same lease used by runs and transcript edits.
          const latestPins = yield* loadPinnedIds(pinnedFile)
          if (!latestPins.ok || latestPins.ids.has(sessionId)) return
          const latestMtime = yield* fsTry("stat basis under lease", () => stat(basis).then((st) => st.mtimeMs)).pipe(
            Effect.orElseSucceed(() => Number.POSITIVE_INFINITY)
          )
          if (latestMtime >= cutoff) return
          const remove = (path: string, recursive: boolean) => fsTry("rm session", () => rm(path, { recursive, force: true })).pipe(
            Effect.as(true),
            Effect.catchAll((error) => Effect.logWarning(error.message).pipe(Effect.as(false)))
          )
          // If the parent cannot be removed, its child history must remain too.
          if (s.jsonl && !(yield* remove(s.jsonl, false))) return
          if (s.subdir && !(yield* remove(s.subdir, true))) return
          yield* Effect.logInfo(
            `session cleanup: removed session ${sessionId} from ${root} under ${cwdName} (older than ${keepDays}d)`
          )
        }).pipe(Effect.uninterruptible, Effect.ensuring(Effect.sync(endEdit)))
      }

      // Keep the shared project directory: a new session may already have
      // initialized its native writer here without persisting its first entry.
    }
  }).pipe(Effect.withSpan("session.cleanup"))

// ─────────────────────────────────────────────────────────
// Service Tag + Layer
// ─────────────────────────────────────────────────────────

export interface SessionCleanupService {
  /** Retention pass over every Built-in Agent store. Exposed for tests. */
  readonly cleanup: Effect.Effect<void, AppError>
}

export const SessionCleanupService = Context.GenericTag<SessionCleanupService>(
  "@cockpit/SessionCleanupService"
)

export const SessionCleanupLive = Layer.scoped(
  SessionCleanupService,
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const roots = [join(cfg.cockpitDir, "pi", "sessions")]
    const pinnedFile = join(cfg.cockpitDir, "pinned-sessions.json")
    // Clamp to >= 1 day: 0 would set cutoff = now and delete every inactive
    // session (mirrors Claude Code rejecting cleanupPeriodDays: 0).
    const keepDays = Math.max(1, cfg.sessionKeepDays)
    // One pass per Built-in Agent store; a missing root is a no-op inside cleanupSessions.
    const sessions = Effect.forEach(roots, (root) => cleanupSessions(root, keepDays, pinnedFile), {
      discard: true,
    })
    // Context snapshots outlive their session when the Claude CLI expires its
    // transcript; sweep those whose transcript is gone (an hour's grace covers a
    // transcript stashed by a running independent turn).
    const contextSnapshots = cleanupOrphanedContextUsage(join(cfg.cockpitDir, "projects"), CLAUDE_PROJECTS_DIR, 3600 * 1000).pipe(
      Effect.tap((removed) => removed > 0 ? Effect.logInfo(`session cleanup: removed ${removed} orphaned context snapshot(s)`) : Effect.void),
      Effect.catchAll((error) => Effect.logWarning("session cleanup: context snapshot sweep failed", error)),
    )
    const cleanup = Effect.zipRight(sessions, contextSnapshots)

    yield* Effect.forkScoped(
      cleanup.pipe(
        Effect.catchAll((e) => Effect.logWarning(`session cleanup failed: ${e.message}`)),
        Effect.repeat(Schedule.spaced("24 hours"))
      )
    )

    return SessionCleanupService.of({ cleanup })
  })
)
