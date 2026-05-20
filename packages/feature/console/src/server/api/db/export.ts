/**
 * /api/db/export — P9 round 2 (Service Tag migration)
 *
 * Export query results as a CSV or JSON file download.
 */
import { Effect } from "effect"
import { handler, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { PgService } from "@cockpit/effect-services"

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  const str = String(value)
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

interface ExportRequest {
  id?: string
  connectionString?: string
  sql?: string
  format?: "json" | "csv"
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as ExportRequest
    if (!body.id || !body.connectionString || !body.sql || !body.format) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.id
            ? "id"
            : !body.connectionString
              ? "connectionString"
              : !body.sql
                ? "sql"
                : "format",
          reason: "missing",
        })
      )
    }
    const { id, connectionString, sql, format } = body

    const pg = yield* PgService
    const result = yield* pg.queryWithMeta(id, connectionString, sql)

    if (!result.fields) {
      return yield* Effect.fail(
        new ValidationError({
          field: "sql",
          reason: "Query did not return rows",
        })
      )
    }

    const fieldNames = result.fields.map((f) => f.name)

    if (format === "json") {
      return new Response(JSON.stringify(result.rows, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="export.json"',
        },
      })
    }

    // CSV
    const lines: string[] = [fieldNames.map(escapeCsvField).join(",")]
    for (const row of result.rows as ReadonlyArray<Record<string, unknown>>) {
      lines.push(
        fieldNames.map((f) => escapeCsvField(row[f])).join(",")
      )
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="export.csv"',
      },
    })
  }).pipe(Effect.withSpan("api.db.export"))
)
