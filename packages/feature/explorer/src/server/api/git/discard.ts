/**
 * /api/git/discard
 *
 * Discard changes:
 *  - tracked:   `git restore <file>`
 *  - untracked: fs.unlink directly
 *
 * Fault-tolerance: each file is tried independently and outcomes are
 * aggregated into the `results` array.
 */
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"

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

const discardOne = (
  cwd: string,
  file: string,
  isUntracked: boolean
): Effect.Effect<FileResult> =>
  Effect.tryPromise({
    try: async () => {
      if (isUntracked) {
        await fs.unlink(path.join(cwd, file))
      } else {
        await execAsync(`git restore "${file}"`, { cwd })
      }
      return { file, success: true } satisfies FileResult
    },
    catch: (err) => ({
      file,
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }),
  }).pipe(Effect.merge) // Failure is folded into the result object, so the Effect is always a success

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
    const isUntracked = !!body.isUntracked
    const results = yield* Effect.all(
      body.files.map((f) => discardOne(cwd, f, isUntracked)),
      { concurrency: 4 }
    )

    return ok({ results })
  }).pipe(Effect.withSpan("api.git.discard"))
)
