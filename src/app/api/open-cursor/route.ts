/**
 * /api/open-cursor — P6 migration
 *
 * Invoke the OS `cursor` command to open a directory (fire-and-forget; failures are logged only).
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

    // fire-and-forget; exec errors go to Logger and do not block the response
    const cwd = body.cwd
    yield* Effect.sync(() => {
      exec(`cursor "${cwd}"`, (error) => {
        if (error) {
          Effect.runFork(
            Effect.logError("[open-cursor]").pipe(
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
