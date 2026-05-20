/**
 * /api/db/connect — open / refresh a Postgres connection and probe basic metadata.
 *
 * Uses the PgService Tag, which is supplied by AppRuntime, so no explicit
 * Effect.provide is needed at the route level.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { PgService } from "@cockpit/effect-services"
import { DBError, ValidationError } from "@cockpit/effect-core"

interface ConnectBody {
  readonly id: string
  readonly connectionString: string
}

type VersionRow = { db: string; version: string } & Record<string, unknown>
type SchemaRow = { schema_name: string } & Record<string, unknown>

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Partial<ConnectBody>
    if (!body.id || !body.connectionString) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id ? "id" : "connectionString",
          reason: "missing",
        })
      )
    }

    const pg = yield* PgService

    // Run two queries concurrently (§8: Effect.all replaces Promise.all)
    const [dbRows, schemaRows] = yield* Effect.all(
      [
        pg.query<VersionRow>(
          body.id,
          body.connectionString,
          "SELECT current_database() AS db, version() AS version"
        ),
        pg.query<SchemaRow>(
          body.id,
          body.connectionString,
          `SELECT schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_toast','pg_catalog','information_schema')
           ORDER BY schema_name`
        ),
      ],
      { concurrency: "unbounded" }
    )

    const first = dbRows[0]
    if (!first) {
      return yield* Effect.fail(
        new DBError({
          db: "pg",
          op: "connect",
          cause: new Error("empty version response"),
        })
      )
    }

    return ok({
      database: first.db,
      version: first.version,
      schemas: schemaRows.map((r) => r.schema_name),
    })
  }).pipe(Effect.withSpan("api.db.connect"))
)
