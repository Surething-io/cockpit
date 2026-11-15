import { indexResponse } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/related — broader 1-hop relatedness around a symbol.
 *
 * Returns callers / callees plus coedit partners.
 * Each result carries one or more `relations` tags explaining why it's
 * here. See relatedBuilder.ts for the algorithm.
 *
 * Query params:
 *   cwd       — absolute project path (validated)
 *   qname     — qualified name (e.g. `Class>method`)
 *   filePath  — optional disambiguation for cross-file name collisions
 *   topK      — 1..30, default 10
 *   include   — structural | coedit | all (default all)
 */
import { Effect } from "effect"
import { getCodeIndex } from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { buildRelated } from "@cockpit/feature-explorer/server/codeMap/analytics/index"
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
    const topK = Math.min(
      Math.max(parseInt(sp.get("topK") ?? "10", 10) || 10, 1),
      30,
    )
    const includeRaw = (sp.get("include") ?? "all").toLowerCase()
    const include: "structural" | "coedit" | "all" =
      includeRaw === "structural" || includeRaw === "coedit"
        ? includeRaw
        : "all"

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason }),
      )
    }
    if (qname.trim().length < 1) {
      return yield* Effect.fail(
        new ValidationError({ field: "qname", reason: "missing" }),
      )
    }
    const cwd = cwdCheck.abs

    const index = yield* Effect.tryPromise({
      try: () => getCodeIndex(cwd),
      catch: (cause) =>
        indexQueryError(cause, "Related lookup failed"),
    })
    const result = yield* buildRelated(index, { qname, filePath, topK, include })
    return indexResponse(index, result)
  }),
)
