/**
 * /api/terminal/aliases — P8+ migration
 */
import * as fs from "fs/promises"
import { Effect } from "effect"
import { getGlobalAliasesPath, ensureParentDir } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DEFAULT_ALIASES: Record<string, string> = {
  ll: "ls -la",
  gs: "git status",
  gp: "git pull",
  gc: "git commit",
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const aliasesFilePath = getGlobalAliasesPath()
    const aliases = yield* Effect.tryPromise({
      try: async () => {
        const content = await fs.readFile(aliasesFilePath, "utf-8")
        return JSON.parse(content) as Record<string, string>
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => DEFAULT_ALIASES))
    return ok({ aliases })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      aliases?: Record<string, string>
    }
    if (!body.aliases) {
      return yield* Effect.fail(
        new ValidationError({ field: "aliases", reason: "missing" })
      )
    }
    const aliasesFilePath = getGlobalAliasesPath()
    yield* Effect.tryPromise({
      try: async () => {
        await ensureParentDir(aliasesFilePath)
        await fs.writeFile(
          aliasesFilePath,
          JSON.stringify(body.aliases, null, 2),
          "utf-8"
        )
      },
      catch: (cause) =>
        new FSError({ path: aliasesFilePath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
