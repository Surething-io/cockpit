/**
 * /api/review/order — P8+ migration (PUT)
 */
import { join } from "path"
import { Effect } from "effect"
import {
  REVIEW_DIR,
  writeJsonFile,
  ensureDir,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

const ORDER_FILE = join(REVIEW_DIR, "_order.json")

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { order?: unknown[] }
    if (!Array.isArray(body.order)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "order",
          reason: "must be an array",
        })
      )
    }
    yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        await writeJsonFile(ORDER_FILE, body.order)
      },
      catch: (cause) =>
        new FSError({ path: ORDER_FILE, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
