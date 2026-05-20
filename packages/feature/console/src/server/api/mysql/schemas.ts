/**
 * /api/mysql/schemas — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { MySQLService } from "@cockpit/effect-services"

type TableRow = {
  name: string
  type: string
  row_estimate: number | null
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const id = sp.get("id")
    const connectionString = sp.get("connectionString")
    const schema = sp.get("schema")

    if (!id || !connectionString || !schema) {
      return yield* Effect.fail(
        new ValidationError({
          field: !id ? "id" : !connectionString ? "connectionString" : "schema",
          reason: "missing",
        })
      )
    }

    const mysql = yield* MySQLService
    const rows = yield* mysql.query<TableRow>(
      id,
      connectionString,
      `SELECT TABLE_NAME AS name,
              TABLE_TYPE AS type,
              TABLE_ROWS AS row_estimate
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [schema]
    )

    return ok({
      tables: rows.map((r) => ({
        name: r.name,
        type: r.type === "BASE TABLE" ? "table" : "view",
        rowEstimate: Math.max(0, Number(r.row_estimate ?? 0)),
      })),
    })
  }).pipe(Effect.withSpan("api.mysql.schemas"))
)
