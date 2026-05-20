/**
 * /api/mysql/connect — P9 second pass (Service Tag migration)
 *
 * Validate the connection + fetch the database list; both queries share the same pool (same id).
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { DBError, ValidationError } from "@cockpit/effect-core"
import { MySQLService } from "@cockpit/effect-services"

interface ConnectBody {
  id?: string
  connectionString?: string
}

type VersionRow = { db: string; version: string }
type DbRow = { Database: string }

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

    const mysql = yield* MySQLService
    const [versionRows, dbRows] = yield* Effect.all(
      [
        mysql.query<VersionRow>(
          id,
          connectionString,
          "SELECT DATABASE() AS db, VERSION() AS version"
        ),
        mysql.query<DbRow>(id, connectionString, "SHOW DATABASES"),
      ],
      { concurrency: "unbounded" }
    )

    const versionRow = versionRows[0]
    if (!versionRow) {
      return yield* Effect.fail(
        new DBError({
          db: "mysql",
          op: "connect",
          cause: new Error("empty version response"),
        })
      )
    }

    const databases = dbRows
      .map((r) => r.Database)
      .filter(
        (d) =>
          !["information_schema", "performance_schema", "mysql", "sys"].includes(
            d
          )
      )

    return ok({
      database: versionRow.db,
      version: versionRow.version,
      schemas: databases,
    })
  }).pipe(Effect.withSpan("api.mysql.connect"))
)
