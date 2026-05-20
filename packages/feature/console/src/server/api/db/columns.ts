/**
 * /api/db/columns — P9 round 2 (Service Tag migration)
 *
 * Fetch table columns / pk / fk / indexes metadata (4 concurrent queries).
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { PgService } from "@cockpit/effect-services"

type ColRow = {
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: string
  column_default: string | null
  character_maximum_length: number | null
}
type PkRow = { column_name: string }
type FkRow = {
  column_name: string
  ref_schema: string
  ref_table: string
  ref_column: string
}
type IdxRow = { indexname: string; indexdef: string }

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const id = sp.get("id")
    const connectionString = sp.get("connectionString")
    const schema = sp.get("schema") || "public"
    const table = sp.get("table")

    if (!id || !connectionString || !table) {
      return yield* Effect.fail(
        new ValidationError({
          field: !id ? "id" : !connectionString ? "connectionString" : "table",
          reason: "missing",
        })
      )
    }

    const pg = yield* PgService

    const [colRows, pkRows, fkRows, idxRows] = yield* Effect.all(
      [
        pg.query<ColRow>(
          id,
          connectionString,
          `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schema, table]
        ),
        pg.query<PkRow>(
          id,
          connectionString,
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
           ORDER BY kcu.ordinal_position`,
          [schema, table]
        ),
        pg.query<FkRow>(
          id,
          connectionString,
          `SELECT kcu.column_name, ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'`,
          [schema, table]
        ),
        pg.query<IdxRow>(
          id,
          connectionString,
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
          [schema, table]
        ),
      ],
      { concurrency: "unbounded" }
    )

    const pkCols = new Set(pkRows.map((r) => r.column_name))

    return ok({
      columns: colRows.map((r) => ({
        name: r.column_name,
        type: r.data_type === "USER-DEFINED" ? r.udt_name : r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default,
        maxLength: r.character_maximum_length,
        isPrimaryKey: pkCols.has(r.column_name),
      })),
      primaryKeys: Array.from(pkCols),
      foreignKeys: fkRows.map((r) => ({
        column: r.column_name,
        refSchema: r.ref_schema,
        refTable: r.ref_table,
        refColumn: r.ref_column,
      })),
      indexes: idxRows.map((r) => ({
        name: r.indexname,
        definition: r.indexdef,
      })),
    })
  }).pipe(Effect.withSpan("api.db.columns"))
)
