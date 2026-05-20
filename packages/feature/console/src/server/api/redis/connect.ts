/**
 * /api/redis/connect — P9 round 2 (Service Tag migration)
 *
 * The info and dbsize commands share a client via RedisService.command using the same id.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

interface ConnectBody {
  id?: string
  connectionString?: string
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as ConnectBody
    if (!body.id || !body.connectionString) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id ? "id" : "connectionString",
          reason: "missing",
        })
      )
    }
    const { id, connectionString } = body

    const redis = yield* RedisService
    const [infoResult, dbSizeResult] = yield* Effect.all(
      [
        redis.command(id, connectionString, "INFO"),
        redis.command(id, connectionString, "DBSIZE"),
      ],
      { concurrency: "unbounded" }
    )

    const info = String(infoResult ?? "")
    const version = info.match(/redis_version:(.+)/)?.[1]?.trim() || "unknown"
    const mode = info.match(/redis_mode:(.+)/)?.[1]?.trim() || "standalone"
    const memory =
      info.match(/used_memory_human:(.+)/)?.[1]?.trim() || "0B"
    const dbSize = Number(dbSizeResult ?? 0)

    return ok({ version, mode, dbSize, memory })
  }).pipe(Effect.withSpan("api.redis.connect"))
)
