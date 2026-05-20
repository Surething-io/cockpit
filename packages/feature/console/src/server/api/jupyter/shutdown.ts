/**
 * /api/jupyter/shutdown — P8+ migration
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"
import { kernelManager } from "@cockpit/feature-console/server"

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { bubbleId?: string }
    if (!body.bubbleId) {
      return yield* Effect.fail(
        new ValidationError({ field: "bubbleId", reason: "missing" })
      )
    }
    const bubbleId = body.bubbleId
    yield* Effect.tryPromise({
      try: () => kernelManager.shutdown(bubbleId),
      catch: (cause) =>
        new AppError({ message: "kernel shutdown failed", cause }),
    })
    return ok({ ok: true })
  })
)
