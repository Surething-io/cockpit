/**
 * /api/git/stage — P8+ migration
 *
 * `git add <files>`
 */
import { execFile } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)

export interface GitStageRequest {
  cwd?: string
  files: string[]
}

const runGit = (
  args: string[],
  cwd: string
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => execFileAsync("git", args, { cwd }).then(() => undefined),
    catch: (cause) =>
      new AppError({ message: `git command failed: git ${args.join(" ")}`, cause }),
  })

const checkIsRepo = (cwd: string): Effect.Effect<void, ValidationError> =>
  runGit(["rev-parse", "--git-dir"], cwd).pipe(
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

    yield* runGit(["add", "--", ...files], cwd)

    return ok({
      success: true,
      files,
      message: `Staged ${files.length} file(s)`,
    })
  }).pipe(Effect.withSpan("api.git.stage"))
)
