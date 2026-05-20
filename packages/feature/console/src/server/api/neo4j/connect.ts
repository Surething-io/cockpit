/**
 * /api/neo4j/connect — P9 round 2 (Service Tag migration)
 *
 * Runs two cypher queries via Neo4jService.run; neo4jCore.serializeValue already
 * serializes Integer to number, so no toNumber() call is required.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { Neo4jService } from "@cockpit/effect-services"

interface ConnectBody {
  id?: string
  connectionString?: string
}

type ComponentRow = { name: string; versions: string[]; edition: string }
type CountRow = { nodes: number; relationships: number }

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

    const neo4j = yield* Neo4jService
    const [compRows, countRows] = yield* Effect.all(
      [
        neo4j.run<ComponentRow>(
          id,
          connectionString,
          "CALL dbms.components() YIELD name, versions, edition"
        ),
        neo4j.run<CountRow>(
          id,
          connectionString,
          "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS relationships"
        ),
      ],
      { concurrency: "unbounded" }
    )

    const component = compRows[0]
    const counts = countRows[0]

    return ok({
      version: component?.versions?.[0] || "unknown",
      edition: component?.edition || "unknown",
      nodeCount: counts?.nodes ?? 0,
      relationshipCount: counts?.relationships ?? 0,
    })
  }).pipe(Effect.withSpan("api.neo4j.connect"))
)
