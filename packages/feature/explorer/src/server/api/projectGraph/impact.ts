import { indexResponse } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/impact — Transitive caller closure (impact radius).
 *
 * Returns the set of symbols that transitively call `qname`, up to `depth`
 * hops. Useful for "if I change X, what should I re-test / re-read?". The
 * BFS is depth-capped (5) and node-capped (500) — heavily-called utilities
 * would otherwise blow the response size and the AI's context budget.
 *
 * Query params:
 *   cwd, qname, filePath — same as callers.ts
 *   depth                — 1..5, defaults to 2
 */
import { Effect } from "effect"
import {
  getCodeIndex,
  impactFromIndex,
} from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const qname = sp.get("qname") ?? ""
    const filePath = sp.get("filePath") ?? undefined
    const depth = Math.min(
      Math.max(parseInt(sp.get("depth") ?? "2", 10) || 2, 1),
      5
    )

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    if (qname.trim().length < 1) {
      return yield* Effect.fail(
        new ValidationError({ field: "qname", reason: "missing" })
      )
    }
    const cwd = cwdCheck.abs

    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        return indexResponse(index, impactFromIndex(index, qname, depth, filePath))
      },
      catch: (cause) =>
        indexQueryError(cause, "Impact lookup failed"),
    })
    return result
  })
)
