/**
 * GoNotesCleanupLive -- retention sweep for `/go` decision notes.
 *
 * `/go` (skills/go/SKILL.md) logs every decision the spec did not cover to
 *   <cockpitDir>/skills/go/notes/<project>-<feature>.md
 * and links the file from its recap. Nothing else writes there and nothing
 * reads it back, so the notes only need to outlive the review that follows a
 * run: a note untouched for KEEP_DAYS is removed.
 *
 * The directory sits inside the dir writeBuiltinSkill regenerates on every
 * dispatch; that writer only overwrites its own files and must never clear the
 * directory (see the comment there).
 *
 * Retention basis is the file mtime, so a task continued in a later round
 * (appended to the same file) restarts its clock. Only `*.md` files directly in
 * the notes directory are ever deleted.
 *
 * Trigger: a daily background pass (first run immediately, then every 24h),
 * forked into the layer's Scope so runtime disposal interrupts it.
 */
import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Schedule } from "effect"
import { AppError, CockpitConfig } from "@cockpit/effect-core"

const KEEP_DAYS = 30
const DAY_MS = 24 * 3600 * 1000

const fsTry = <A>(op: string, fn: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new AppError({ message: `go-notes cleanup fs ${op} failed`, cause }),
  })

/** `<cockpitDir>/skills/go/notes` — must match the path in skills/go/SKILL.md. */
export const goNotesDir = (cockpitDir: string): string => join(cockpitDir, "skills", "go", "notes")

/** Remove notes in `notesDir` untouched for more than `keepDays`. */
export const cleanupGoNotes = (
  notesDir: string,
  keepDays: number,
  now: number = Date.now()
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const cutoff = now - keepDays * DAY_MS
    const files = yield* fsTry("readdir", () => readdir(notesDir)).pipe(
      Effect.orElseSucceed(() => [] as string[])
    )
    for (const name of files) {
      if (!name.endsWith(".md")) continue
      const file = join(notesDir, name)
      const mtime = yield* fsTry("stat", () => stat(file).then((s) => s.mtimeMs)).pipe(
        Effect.orElseSucceed(() => Number.POSITIVE_INFINITY) // stat fail -> keep
      )
      if (mtime >= cutoff) continue
      yield* fsTry("rm", () => rm(file, { force: true })).pipe(Effect.orElseSucceed(() => undefined))
      yield* Effect.logInfo(`go-notes cleanup: removed ${name} (older than ${keepDays}d)`)
    }
  }).pipe(Effect.withSpan("goNotes.cleanup"))

// ─────────────────────────────────────────────────────────
// Service Tag + Layer
// ─────────────────────────────────────────────────────────

export interface GoNotesCleanupService {
  /** Retention pass over the go notes directory. Exposed for tests. */
  readonly cleanup: Effect.Effect<void, never>
}

export const GoNotesCleanupService = Context.GenericTag<GoNotesCleanupService>(
  "@cockpit/GoNotesCleanupService"
)

export const GoNotesCleanupLive = Layer.scoped(
  GoNotesCleanupService,
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const cleanup = Effect.suspend(() => cleanupGoNotes(goNotesDir(cfg.cockpitDir), KEEP_DAYS))

    yield* Effect.forkScoped(cleanup.pipe(Effect.repeat(Schedule.spaced("24 hours"))))

    return GoNotesCleanupService.of({ cleanup })
  })
)
