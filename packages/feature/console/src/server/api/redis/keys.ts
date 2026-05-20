/**
 * /api/redis/keys — P9 round 2 (Service Tag migration)
 *
 * SCAN-based pagination plus concurrent TYPE lookups (local Redis is <10ms, so concurrency replaces the v1 pipeline).
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

interface KeysBody {
  id?: string
  connectionString?: string
  pattern?: string
  cursor?: string
  count?: number
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as KeysBody
    if (!body.id || !body.connectionString) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id ? "id" : "connectionString",
          reason: "missing",
        })
      )
    }
    const {
      id,
      connectionString,
      pattern = "*",
      cursor = "0",
      count = 100,
    } = body

    const redis = yield* RedisService
    const scanResult = (yield* redis.command(id, connectionString, "SCAN", [
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      count,
    ])) as [string, string[]]
    const [nextCursor, keys] = scanResult

    if (keys.length === 0) {
      return ok({
        keys: [],
        cursor: nextCursor,
        hasMore: nextCursor !== "0",
      })
    }

    const types = yield* Effect.all(
      keys.map(
        (k) =>
          redis.command(id, connectionString, "TYPE", [k]) as Effect.Effect<
            string,
            never
          >
      ),
      { concurrency: "unbounded" }
    )

    return ok({
      keys: keys.map((key, i) => ({
        key,
        type: types[i] || "unknown",
      })),
      cursor: nextCursor,
      hasMore: nextCursor !== "0",
    })
  }).pipe(Effect.withSpan("api.redis.keys"))
)
