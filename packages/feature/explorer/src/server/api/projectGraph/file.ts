import { indexResponse } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/file — P8+ migration
 */
import { Effect } from "effect"
import {
  fileDetailFromIndex,
  getCodeIndex,
} from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler } from "@cockpit/effect-runtime/server"
import {
  NotFoundError,
  ValidationError,
} from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const filePath = sp.get("path")

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    const cwd = cwdCheck.abs
    if (!filePath) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }

    const detail = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        return { index, payload: fileDetailFromIndex(index, filePath) }
      },
      catch: (cause) => {
        return indexQueryError(cause, "Failed to load file detail")
      },
    })

    if (!detail.payload) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "projectGraph.file", id: filePath })
      )
    }
    return indexResponse(detail.index, detail.payload)
  })
)
