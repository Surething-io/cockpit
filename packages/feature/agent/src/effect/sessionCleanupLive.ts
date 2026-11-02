// Scoped retention for native Pi sessions. Claude and Codex retain their own stores.
import { readdir, readFile, rm, rmdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Schedule } from "effect"
import { AppError, CockpitConfig } from "@cockpit/effect-core"

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
        const sessionId = yield* Effect.tryPromise({
          try: async () => (await import("@earendil-works/pi-coding-agent")).SessionManager.open(full).getSessionId(),
          catch: (cause) => new AppError({ message: "Cannot read Pi session header", cause }),
        })
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

        if (s.jsonl) {
          yield* fsTry("rm jsonl", () => rm(s.jsonl!, { force: true })).pipe(
            Effect.orElseSucceed(() => undefined)
          )
        }
        if (s.subdir) {
          yield* fsTry("rm subdir", () =>
            rm(s.subdir!, { recursive: true, force: true })
          ).pipe(Effect.orElseSucceed(() => undefined))
        }
        yield* Effect.logInfo(
          `session cleanup: removed session ${sessionId} from ${root} under ${cwdName} (older than ${keepDays}d)`
        )
      }

      // Reclaim an emptied project directory.
      const rest = yield* fsTry("readdir cwd (recount)", () => readdir(cwdDir)).pipe(
        Effect.orElseSucceed(() => ["keep"] as string[])
      )
      if (rest.length === 0) {
        yield* fsTry("rmdir cwd", () => rmdir(cwdDir)).pipe(
          Effect.orElseSucceed(() => undefined)
        )
      }
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
    const cleanup = Effect.forEach(roots, (root) => cleanupSessions(root, keepDays, pinnedFile), {
      discard: true,
    })

    yield* Effect.forkScoped(
      cleanup.pipe(
        Effect.catchAll((e) => Effect.logWarning(`session cleanup failed: ${e.message}`)),
        Effect.repeat(Schedule.spaced("24 hours"))
      )
    )

    return SessionCleanupService.of({ cleanup })
  })
)
