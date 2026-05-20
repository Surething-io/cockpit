/**
 * /api/terminal/bubble-order — P8+ migration
 */
import { Effect } from "effect"
import {
  getBubbleOrderPath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const tabId = sp.get("tabId")
    if (!cwd || !tabId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? "cwd" : "tabId",
          reason: "missing",
        })
      )
    }
    const orderPath = getBubbleOrderPath(cwd, tabId)
    const order = yield* Effect.tryPromise({
      try: () => readJsonFile<string[]>(orderPath, []),
      catch: (cause) =>
        new FSError({ path: orderPath, op: "read", cause }),
    })
    return ok({ order })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      tabId?: string
      order?: string[]
    }
    if (!body.cwd || !body.tabId || !Array.isArray(body.order)) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : !body.tabId ? "tabId" : "order",
          reason: "missing or invalid",
        })
      )
    }
    const orderPath = getBubbleOrderPath(body.cwd, body.tabId)
    yield* Effect.tryPromise({
      try: () => writeJsonFile(orderPath, body.order),
      catch: (cause) =>
        new FSError({ path: orderPath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
