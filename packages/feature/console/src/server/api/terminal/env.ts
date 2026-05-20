/**
 * /api/terminal/env — P8+ migration
 */
import * as fs from "fs/promises"
import { Effect } from "effect"
import { getTerminalEnvPath, ensureParentDir } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const tabId = sp.get("tabId")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const envFilePath = getTerminalEnvPath(cwd, tabId || undefined)
    const env = yield* Effect.tryPromise({
      try: async () => {
        const content = await fs.readFile(envFilePath, "utf-8")
        return JSON.parse(content) as Record<string, string>
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>))
    return ok({ env })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      tabId?: string
      env?: Record<string, string>
    }
    if (!body.cwd || !body.env) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "env",
          reason: "missing",
        })
      )
    }
    const envFilePath = getTerminalEnvPath(body.cwd, body.tabId)
    yield* Effect.tryPromise({
      try: async () => {
        await ensureParentDir(envFilePath)
        await fs.writeFile(
          envFilePath,
          JSON.stringify(body.env, null, 2),
          "utf-8"
        )
      },
      catch: (cause) =>
        new FSError({ path: envFilePath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
