/**
 * /api/git/stage — P8+ migration
 *
 * `git add <files>`
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

export interface GitStageRequest {
  cwd?: string
  files: string[]
}

const runGit = (
  cmd: string,
  cwd: string
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => execAsync(cmd, { cwd }).then(() => undefined),
    catch: (cause) =>
      new AppError({ message: `git command failed: ${cmd}`, cause }),
  })

const checkIsRepo = (cwd: string): Effect.Effect<void, ValidationError> =>
  runGit("git rev-parse --git-dir", cwd).pipe(
    Effect.mapError(
      () =>
        new ValidationError({ field: "cwd", reason: "not a git repository" })
    )
  )

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Partial<GitStageRequest>
    const cwd = body.cwd || process.cwd()
    const files = body.files

    if (!files || !Array.isArray(files) || files.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ field: "files", reason: "missing or empty" })
      )
    }

    yield* checkIsRepo(cwd)

    // Escape file paths (spaces / special chars)
    const escaped = files
      .map((f) => `"${f.replace(/"/g, '\\"')}"`)
      .join(" ")

    yield* runGit(`git add ${escaped}`, cwd)

    return ok({
      success: true,
      files,
      message: `Staged ${files.length} file(s)`,
    })
  }).pipe(Effect.withSpan("api.git.stage"))
)
