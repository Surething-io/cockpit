/**
 * /api/redis/command — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

interface CommandBody {
  id?: string
  connectionString?: string
  command?: string
  args?: unknown[]
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as CommandBody
    if (!body.id || !body.connectionString || !body.command) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id
            ? "id"
            : !body.connectionString
              ? "connectionString"
              : "command",
          reason: "missing",
        })
      )
    }
    const { id, connectionString, command, args = [] } = body

    const redis = yield* RedisService
    const start = performance.now()
    const result = yield* redis.command(id, connectionString, command, args)
    const duration = Math.round((performance.now() - start) * 100) / 100

    return ok({ result, duration })
  }).pipe(Effect.withSpan("api.redis.command"))
)
