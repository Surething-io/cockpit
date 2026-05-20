/**
 * /api/redis/disconnect — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { id?: string }
    if (!body.id) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }
    const redis = yield* RedisService
    yield* redis.disconnect(body.id)
    return ok({ success: true })
  }).pipe(Effect.withSpan("api.redis.disconnect"))
)
