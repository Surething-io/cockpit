/**
 * /api/redis/set — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

interface SetBody {
  id?: string
  connectionString?: string
  key?: string
  value?: string
  type?: "string" | "hash" | "list" | "set" | "zset"
  field?: string
  ttl?: number
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as SetBody
    if (!body.id || !body.connectionString || body.key === undefined) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id
            ? "id"
            : !body.connectionString
              ? "connectionString"
              : "key",
          reason: "missing",
        })
      )
    }
    const { id, connectionString, key, value, type, field, ttl } = body
    const redis = yield* RedisService
    const cmd = (name: string, ...args: unknown[]) =>
      redis.command(id, connectionString, name, args)

    switch (type) {
      case "string":
        yield* cmd("SET", key, value ?? "")
        break
      case "hash":
        if (field !== undefined) {
          yield* cmd("HSET", key, field, value ?? "")
        }
        break
      case "list":
      case "set":
      case "zset":
        // Direct modification not supported; use CLI
        break
      default:
        yield* cmd("SET", key, value ?? "")
    }

    if (ttl !== undefined && ttl > 0) {
      yield* cmd("EXPIRE", key, ttl)
    }

    return ok({ ok: true })
  }).pipe(Effect.withSpan("api.redis.set"))
)
