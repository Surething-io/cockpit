/**
 * /api/redis/get — P9 round 2 (Service Tag migration)
 *
 * Fetches the value by key type (string / hash / list / set / zset / stream),
 * and concurrently queries ttl + memory. All commands go through RedisService.command.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

const MAX_ITEMS = 500

interface GetBody {
  id?: string
  connectionString?: string
  key?: string
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as GetBody
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
    const { id, connectionString, key } = body
    const redis = yield* RedisService
    const cmd = <A>(name: string, ...args: unknown[]) =>
      redis.command(id, connectionString, name, args) as Effect.Effect<A, never>

    const [type, ttl, size] = yield* Effect.all(
      [
        cmd<string>("TYPE", key),
        cmd<number>("TTL", key),
        cmd<number | null>("MEMORY", "USAGE", key).pipe(
          Effect.orElseSucceed(() => null)
        ),
      ],
      { concurrency: "unbounded" }
    )

    let value: unknown
    switch (type) {
      case "string":
        value = yield* cmd<string | null>("GET", key)
        break
      case "hash":
        value = yield* cmd<Record<string, string>>("HGETALL", key)
        break
      case "list": {
        const len = yield* cmd<number>("LLEN", key)
        const items = yield* cmd<string[]>(
          "LRANGE",
          key,
          0,
          Math.min(len, MAX_ITEMS) - 1
        )
        value = { items, total: len }
        break
      }
      case "set": {
        const card = yield* cmd<number>("SCARD", key)
        const members = yield* cmd<string[] | null>(
          "SRANDMEMBER",
          key,
          Math.min(card, MAX_ITEMS)
        )
        value = { items: members || [], total: card }
        break
      }
      case "zset": {
        const len = yield* cmd<number>("ZCARD", key)
        const raw = yield* cmd<string[]>(
          "ZRANGE",
          key,
          0,
          Math.min(len, MAX_ITEMS) - 1,
          "WITHSCORES"
        )
        const pairs: { member: string; score: string }[] = []
        for (let i = 0; i < raw.length; i += 2) {
          pairs.push({ member: raw[i], score: raw[i + 1] })
        }
        value = { items: pairs, total: len }
        break
      }
      case "stream": {
        const len = yield* cmd<number>("XLEN", key)
        const entries = yield* cmd<unknown[]>(
          "XRANGE",
          key,
          "-",
          "+",
          "COUNT",
          MAX_ITEMS
        )
        value = { entries, total: len }
        break
      }
      default:
        value = null
    }

    return ok({ type, value, ttl, size })
  }).pipe(Effect.withSpan("api.redis.get"))
)
