/**
 * /api/neo4j/query — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { Neo4jService } from "@cockpit/effect-services"

interface QueryRequest {
  id?: string
  connectionString?: string
  cypher?: string
  params?: Record<string, unknown>
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as QueryRequest
    if (!body.id || !body.connectionString || !body.cypher) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id
            ? "id"
            : !body.connectionString
              ? "connectionString"
              : "cypher",
          reason: "missing",
        })
      )
    }
    const { id, connectionString, cypher, params } = body

    const neo4j = yield* Neo4jService
    const result = yield* neo4j.runWithMeta(id, connectionString, cypher, params)
    return ok(result)
  }).pipe(Effect.withSpan("api.neo4j.query"))
)
