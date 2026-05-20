/**
 * /api/mysql/query — P9 round 2 (Service Tag migration)
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { MySQLService } from "@cockpit/effect-services"

const MAX_ROWS = 1000

interface QueryRequest {
  id?: string
  connectionString?: string
  sql?: string
  params?: unknown[]
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as QueryRequest
    if (!body.id || !body.connectionString || !body.sql) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id
            ? "id"
            : !body.connectionString
              ? "connectionString"
              : "sql",
          reason: "missing",
        })
      )
    }
    const { id, connectionString, sql, params } = body

    const mysql = yield* MySQLService
    const result = yield* mysql.queryWithMeta(id, connectionString, sql, params)

    // SELECT path: fields is non-null
    if (result.fields !== null) {
      const truncated = result.rows.length > MAX_ROWS
      return ok({
        fields: result.fields,
        rows: truncated ? result.rows.slice(0, MAX_ROWS) : result.rows,
        rowCount: result.rowCount,
        truncated,
        duration: result.duration,
      })
    }

    // DML/DDL path
    return ok({
      command: result.command,
      rowCount: result.rowCount,
      duration: result.duration,
    })
  }).pipe(Effect.withSpan("api.mysql.query"))
)
