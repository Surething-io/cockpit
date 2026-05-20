/**
 * /api/projectGraph/search — P8+ migration
 */
import { Effect } from "effect"
import {
  getCodeIndex,
  searchIndex,
} from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const q = sp.get("q") ?? ""
    const limit = Math.min(
      Math.max(parseInt(sp.get("limit") ?? "15", 10) || 15, 1),
      100
    )
    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    const cwd = cwdCheck.abs
    if (q.trim().length < 1) {
      return ok({ modules: [], files: [], symbols: [] })
    }
    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        return searchIndex(index, q, limit)
      },
      catch: (cause) =>
        new AppError({ message: "Search failed", cause }),
    })
    return ok(result)
  })
)
