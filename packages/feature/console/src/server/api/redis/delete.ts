/**
 * /api/redis/delete — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

interface DeleteBody {
  id?: string
  connectionString?: string
  keys?: string[]
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as DeleteBody
    if (
      !body.id ||
      !body.connectionString ||
      !Array.isArray(body.keys) ||
      body.keys.length === 0
    ) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id
            ? "id"
            : !body.connectionString
              ? "connectionString"
              : "keys",
          reason: "missing or empty",
        })
      )
    }
    const { id, connectionString, keys } = body
    const redis = yield* RedisService
    const deleted = yield* redis.command(id, connectionString, "DEL", keys)
    return ok({ deleted })
  }).pipe(Effect.withSpan("api.redis.delete"))
)
