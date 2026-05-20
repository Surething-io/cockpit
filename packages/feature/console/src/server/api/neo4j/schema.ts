/**
 * /api/neo4j/schema — P9 second pass (Service Tag migration)
 *
 * Lists labels / relationship types / property keys / indexes / constraints.
 * Uses Neo4jService.run to reuse the driver (serializeValue automatically
 * converts Integer → number, so this route no longer needs toNumber()).
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { Neo4jService } from "@cockpit/effect-services"

interface SchemaBody {
  id?: string
  connectionString?: string
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as SchemaBody
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

    // Run the 4 schema metadata cyphers concurrently
    const [labelRows, relTypeRows, propRows, idxRows, conRows] =
      yield* Effect.all(
        [
          neo4j.run<{ label: string }>(
            id,
            connectionString,
            "CALL db.labels() YIELD label RETURN label ORDER BY label"
          ),
          neo4j.run<{ relationshipType: string }>(
            id,
            connectionString,
            "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType"
          ),
          neo4j.run<{ propertyKey: string }>(
            id,
            connectionString,
            "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey"
          ),
          neo4j.run<{
            name: string
            type: string
            labelsOrTypes: unknown
            properties: unknown
            state: string
          }>(
            id,
            connectionString,
            "SHOW INDEXES YIELD name, type, labelsOrTypes, properties, state"
          ),
          neo4j.run<{
            name: string
            type: string
            labelsOrTypes: unknown
            properties: unknown
          }>(
            id,
            connectionString,
            "SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties"
          ),
        ],
        { concurrency: "unbounded" }
      )

    const labels = labelRows.map((r) => r.label)
    const relTypes = relTypeRows.map((r) => r.relationshipType)

    // labels count + relTypes count — concurrent (N+M cyphers); acceptable for small DBs
    const labelCountEffs = labels.map((l) =>
      neo4j
        .run<{ cnt: number }>(
          id,
          connectionString,
          `MATCH (n:\`${l}\`) RETURN count(n) AS cnt`
        )
        .pipe(Effect.map((rows) => ({ name: l, count: rows[0]?.cnt ?? 0 })))
    )
    const relCountEffs = relTypes.map((rt) =>
      neo4j
        .run<{ cnt: number }>(
          id,
          connectionString,
          `MATCH ()-[r:\`${rt}\`]->() RETURN count(r) AS cnt`
        )
        .pipe(Effect.map((rows) => ({ name: rt, count: rows[0]?.cnt ?? 0 })))
    )
    const [labelCounts, relCounts] = yield* Effect.all(
      [
        Effect.all(labelCountEffs, { concurrency: "unbounded" }),
        Effect.all(relCountEffs, { concurrency: "unbounded" }),
      ],
      { concurrency: "unbounded" }
    )

    return ok({
      labels: labelCounts,
      relationshipTypes: relCounts,
      propertyKeys: propRows.map((r) => r.propertyKey),
      indexes: idxRows.map((r) => ({
        name: r.name,
        type: r.type,
        labelsOrTypes: r.labelsOrTypes,
        properties: r.properties,
        state: r.state,
      })),
      constraints: conRows.map((r) => ({
        name: r.name,
        type: r.type,
        labelsOrTypes: r.labelsOrTypes,
        properties: r.properties,
      })),
    })
  }).pipe(Effect.withSpan("api.neo4j.schema"))
)
