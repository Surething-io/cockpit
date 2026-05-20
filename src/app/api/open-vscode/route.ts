/**
 * /api/open-vscode — P6 migration
 *
 * Trigger the OS `code` command to open a directory (fire-and-forget; failures only logged).
 */
import { exec } from "child_process"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { cwd?: string }
    if (!body.cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }

    const cwd = body.cwd
    yield* Effect.sync(() => {
      exec(`code "${cwd}"`, (error) => {
        if (error) {
          Effect.runFork(
            Effect.logError("[open-vscode]").pipe(
              Effect.annotateLogs("cwd", cwd),
              Effect.annotateLogs("error", String(error))
            )
          )
        }
      })
    })

    return ok({ success: true })
  })
)
