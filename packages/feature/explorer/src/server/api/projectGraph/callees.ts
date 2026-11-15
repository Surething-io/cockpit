import { indexResponse } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/callees — What does this symbol call?
 *
 * Mirror of callers.ts: returns the symbols that `qname` invokes (both
 * intra-file and cross-file outgoing). Coordinates only.
 */
import { Effect } from "effect"
import {
  calleesFromIndex,
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
        return indexResponse(index, calleesFromIndex(index, qname, filePath))
      },
      catch: (cause) =>
        indexQueryError(cause, "Callees lookup failed"),
    })
    return result
  })
)
