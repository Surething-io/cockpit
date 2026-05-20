/**
 * /api/mysql/columns — P9 round 2 (Service Tag migration)
 *
 * Three concurrent queries: columns / foreign-keys / indexes.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { MySQLService } from "@cockpit/effect-services"

type ColRow = {
  COLUMN_NAME: string
  DATA_TYPE: string
  COLUMN_TYPE: string
  IS_NULLABLE: string
  COLUMN_DEFAULT: string | null
  CHARACTER_MAXIMUM_LENGTH: number | null
  COLUMN_KEY: string
}
type FkRow = {
  COLUMN_NAME: string
  REFERENCED_TABLE_SCHEMA: string
  REFERENCED_TABLE_NAME: string
  REFERENCED_COLUMN_NAME: string
}
type IdxRow = {
  INDEX_NAME: string
  NON_UNIQUE: number
  COLUMN_NAME: string
  SEQ_IN_INDEX: number
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const id = sp.get("id")
    const connectionString = sp.get("connectionString")
    const schema = sp.get("schema")
    const table = sp.get("table")

    if (!id || !connectionString || !schema || !table) {
      return yield* Effect.fail(
        new ValidationError({
          field: !id
            ? "id"
            : !connectionString
              ? "connectionString"
              : !schema
                ? "schema"
                : "table",
          reason: "missing",
        })
      )
    }

    const mysql = yield* MySQLService

    const [colRows, fkRows, idxRows] = yield* Effect.all(
      [
        mysql.query<ColRow>(
          id,
          connectionString,
          `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_MAXIMUM_LENGTH, COLUMN_KEY
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [schema, table]
        ),
        mysql.query<FkRow>(
          id,
          connectionString,
          `SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [schema, table]
        ),
        mysql.query<IdxRow>(
          id,
          connectionString,
          `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [schema, table]
        ),
      ],
      { concurrency: "unbounded" }
    )

    const columns = colRows.map((r) => ({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      default: r.COLUMN_DEFAULT,
      maxLength: r.CHARACTER_MAXIMUM_LENGTH,
      isPrimaryKey: r.COLUMN_KEY === "PRI",
    }))

    const primaryKeys = columns
      .filter((c) => c.isPrimaryKey)
      .map((c) => c.name)

    const foreignKeys = fkRows.map((r) => ({
      column: r.COLUMN_NAME,
      refSchema: r.REFERENCED_TABLE_SCHEMA,
      refTable: r.REFERENCED_TABLE_NAME,
      refColumn: r.REFERENCED_COLUMN_NAME,
    }))

    // Group index columns by index name
    const idxMap = new Map<
      string,
      { name: string; columns: string[]; unique: boolean }
    >()
    for (const r of idxRows) {
      if (!idxMap.has(r.INDEX_NAME)) {
        idxMap.set(r.INDEX_NAME, {
          name: r.INDEX_NAME,
          columns: [],
          unique: r.NON_UNIQUE === 0,
        })
      }
      idxMap.get(r.INDEX_NAME)!.columns.push(r.COLUMN_NAME)
    }

    const indexes = Array.from(idxMap.values()).map((idx) => ({
      name: idx.name,
      definition: `${idx.unique ? "UNIQUE " : ""}INDEX (${idx.columns.join(", ")})`,
    }))

    return ok({ columns, primaryKeys, foreignKeys, indexes })
  }).pipe(Effect.withSpan("api.mysql.columns"))
)
