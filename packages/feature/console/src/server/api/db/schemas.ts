/**
 * /api/db/schemas — P9 round 2 (Service Tag migration)
 *
 * List all tables/views under a schema + rowEstimate.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { PgService } from "@cockpit/effect-services"

type TableRow = {
  name: string
  type: string
  row_estimate: string
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const id = sp.get("id")
    const connectionString = sp.get("connectionString")
    const schema = sp.get("schema") || "public"

    if (!id || !connectionString) {
      return yield* Effect.fail(
        new ValidationError({
          field: !id ? "id" : "connectionString",
          reason: "missing",
        })
      )
    }

    const pg = yield* PgService
    const rows = yield* pg.query<TableRow>(
      id,
      connectionString,
      `SELECT t.table_name AS name,
              t.table_type AS type,
              COALESCE(c.reltuples, 0)::bigint AS row_estimate
       FROM information_schema.tables t
       LEFT JOIN pg_class c ON c.relname = t.table_name
         AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
       WHERE t.table_schema = $1
       ORDER BY t.table_name`,
      [schema]
    )

    return ok({
      tables: rows.map((r) => ({
        name: r.name,
        type: r.type === "BASE TABLE" ? "table" : "view",
        rowEstimate: Math.max(0, Number(r.row_estimate)),
      })),
    })
  }).pipe(Effect.withSpan("api.db.schemas"))
)
