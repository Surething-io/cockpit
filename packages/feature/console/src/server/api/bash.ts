/**
 * /api/bash — P8+ migration
 *
 * Chat's ! prefix command; lightweight bash execution (does not go through the terminal WS).
 */
import { exec } from "child_process"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      command?: unknown
      cwd?: string
    }
    if (!body.command || typeof body.command !== "string") {
      return yield* Effect.fail(
        new ValidationError({ field: "command", reason: "missing" })
      )
    }
    const { command, cwd } = body

    const result = yield* Effect.promise(
      () =>
        new Promise<{
          stdout: string
          stderr: string
          exitCode: number
        }>((resolve) => {
          exec(
            command,
            {
              cwd: cwd || process.cwd(),
              timeout: 30000,
              maxBuffer: 1024 * 1024,
              env: { ...process.env, FORCE_COLOR: "0" },
            },
            (error, stdout, stderr) => {
              resolve({
                stdout: stdout || "",
                stderr: stderr || "",
                exitCode:
                  (error?.code as number | undefined) ??
                  (error ? 1 : 0),
              })
            }
          )
        })
    )

    return ok({ ok: true, ...result })
  })
)
