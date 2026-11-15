import { indexResponse } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/callers — Who calls this symbol?
 *
 * Returns coordinates only (file, line range, qname, kind, params) — never
 * source. The caller (an AI agent under /cg, or a script) is expected to
 * use Read with `offset` / `limit` to fetch source after locating.
 *
 * Query params:
 *   cwd       — absolute project path (validated)
 *   qname     — qualified symbol name in `Parent>Child` form (as emitted by
 *               extractSymbols and surfaced by /api/projectGraph/search)
 *   filePath  — optional, disambiguates when the same qname exists in
 *               multiple files. Ambiguous requests return a null target,
 *               no relations, and all candidate paths in `ambiguousIn`.
 */
import { Effect } from "effect"
import {
  callersFromIndex,
  getCodeIndex,
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
        return indexResponse(index, callersFromIndex(index, qname, filePath))
      },
      catch: (cause) =>
        indexQueryError(cause, "Callers lookup failed"),
    })
    return result
  })
)
