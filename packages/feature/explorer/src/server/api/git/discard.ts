/**
 * /api/git/discard
 *
 * Discard changes:
 *  - tracked:   single batch `git restore -- f1 f2 ...` (one fork, one
 *               .git/index.lock acquisition — matches unstage.ts / stage.ts).
 *  - untracked: concurrent fs.unlink (FS operations don't contend for shared
 *               locks).
 *
 * History note: this route used to run N concurrent `git restore` processes
 * via `Effect.all(..., { concurrency: 4 })`. Multiple restore processes raced
 * for `.git/index.lock` and most failed immediately. The failures were folded
 * into a per-file `results` array via `Effect.merge`, and the client never
 * inspected `results` — so the UI reported success while only a subset of
 * files were actually discarded, forcing the user to click "Discard All"
 * repeatedly. Both the concurrency and the silent-fold are gone now: tracked
 * files go through one batched command, and any per-file failure (untracked
 * unlink) is lifted to `Effect.fail` so the client sees a real error toast.
 */
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

interface DiscardRequest {
  cwd?: string
  files?: string[]
  isUntracked?: boolean
}

interface FileResult {
  file: string
  success: boolean
  error?: string
}

/**
 * Delete one untracked file. Failure is folded into FileResult so a single
 * missing file doesn't abort the whole batch; the request-level aggregator
 * decides whether partial failure should fail the HTTP response.
 */
const unlinkOne = (cwd: string, file: string): Effect.Effect<FileResult> =>
  Effect.tryPromise({
    try: async () => {
      await fs.unlink(path.join(cwd, file))
      return { file, success: true } satisfies FileResult
    },
    catch: (err) =>
      ({
        file,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }) satisfies FileResult,
  }).pipe(Effect.merge)

/**
 * Batch restore: one `git restore -- f1 f2 ...` subprocess for the whole set.
 * Single index-lock acquisition, no race. If git exits non-zero the entire
 * batch is reported as failed (the AppError carries stderr in `cause`).
 */
const restoreBatch = (
  cwd: string,
  files: string[]
): Effect.Effect<FileResult[], AppError> =>
  Effect.tryPromise({
    try: async () => {
      const escaped = files
        .map((f) => `"${f.replace(/"/g, '\\"')}"`)
        .join(" ")
      await execAsync(`git restore -- ${escaped}`, { cwd })
      return files.map(
        (f) => ({ file: f, success: true }) satisfies FileResult
      )
    },
    catch: (cause) =>
      new AppError({
        message: `git restore failed for ${files.length} file(s)`,
        cause,
      }),
  })

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as DiscardRequest

    if (
      !body.cwd ||
      !body.files ||
      !Array.isArray(body.files) ||
      body.files.length === 0
    ) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "files",
          reason: "missing or empty",
        })
      )
    }

    const cwd = body.cwd
    const files = body.files
    const isUntracked = !!body.isUntracked

    // Type annotation makes the ternary's unified error channel explicit:
    // restoreBatch can fail with AppError, the unlink path can't (Effect.merge
    // folds errors into FileResult), and yield* lifts the union into the
    // generator's error channel.
    const op: Effect.Effect<FileResult[], AppError> = isUntracked
      ? Effect.all(
          files.map((f) => unlinkOne(cwd, f)),
          { concurrency: 4 }
        )
      : restoreBatch(cwd, files)

    const results = yield* op

    // Surface partial failure to the client. Without this, a missing untracked
    // file (or any other unlink error) would be silently dropped — exactly the
    // class of bug this rewrite is fixing.
    const failed = results.filter((r) => !r.success)
    if (failed.length > 0) {
      const preview = failed
        .slice(0, 3)
        .map((f) => f.file)
        .join(", ")
      return yield* Effect.fail(
        new AppError({
          message: `discard failed for ${failed.length}/${results.length} file(s): ${preview}${failed.length > 3 ? ", ..." : ""}`,
          cause: failed,
        })
      )
    }

    return ok({ results })
  }).pipe(Effect.withSpan("api.git.discard"))
)
