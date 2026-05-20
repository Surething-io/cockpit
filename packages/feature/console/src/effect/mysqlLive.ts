/**
 * MySQLServiceLive — P9 Layer.scoped lifecycle
 * Same strategy as pgLive: Ref<Map> + process-level finalizer.
 */
import { Effect, Layer, Ref } from "effect"
import mysql from "mysql2/promise"
import { DBError } from "@cockpit/effect-core"
import { MySQLService, type MySQLTx, type Row, type MySQLQueryResult } from "@cockpit/effect-services"

type Pool = mysql.Pool

interface ManagedPool {
  pool: Pool
  connectionString: string
  createdAt: number
}

const handleAsync = <A>(
  op: string,
  f: () => Promise<A>
): Effect.Effect<A, DBError> =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new DBError({ db: "mysql", op, cause }),
  })

const acquirePool = (
  poolsRef: Ref.Ref<Map<string, ManagedPool>>,
  id: string,
  connectionString: string
): Effect.Effect<Pool, DBError> =>
  Effect.gen(function* () {
    const pools = yield* Ref.get(poolsRef)
    const existing = pools.get(id)
    if (existing && existing.connectionString === connectionString) {
      return existing.pool
    }
    if (existing) {
      yield* handleAsync("end", () => existing.pool.end()).pipe(
        Effect.orElse(() => Effect.void)
      )
    }
    const pool = mysql.createPool({
      uri: connectionString,
      connectionLimit: 5,
      idleTimeout: 60000,
      connectTimeout: 10000,
    })
    yield* Ref.update(poolsRef, (m) => {
      const next = new Map(m)
      next.set(id, { pool, connectionString, createdAt: Date.now() })
      return next
    })
    return pool
  })

const disconnectPool = (
  poolsRef: Ref.Ref<Map<string, ManagedPool>>,
  id: string
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const pools = yield* Ref.get(poolsRef)
    const managed = pools.get(id)
    if (!managed) return
    yield* handleAsync("disconnect", () => managed.pool.end()).pipe(
      Effect.orElse(() => Effect.void)
    )
    yield* Ref.update(poolsRef, (m) => {
      const next = new Map(m)
      next.delete(id)
      return next
    })
  })

export const MySQLServiceLive = Layer.scoped(
  MySQLService,
  Effect.gen(function* () {
    const poolsRef = yield* Ref.make(new Map<string, ManagedPool>())

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pools = yield* Ref.get(poolsRef)
        for (const { pool } of pools.values()) {
          yield* Effect.tryPromise({
            try: () => pool.end(),
            catch: (cause) => new DBError({ db: "mysql", op: "shutdown end", cause }),
          }).pipe(Effect.orElse(() => Effect.void))
        }
        yield* Ref.set(poolsRef, new Map())
        yield* Effect.logInfo(
          `[MySQLServiceLive] disposed ${pools.size} pool(s)`
        )
      })
    )

    return MySQLService.of({
      query: (id, connStr, sql, params) =>
        Effect.gen(function* () {
          const pool = yield* acquirePool(poolsRef, id, connStr)
          const [rows] = yield* handleAsync("query", () =>
            pool.query(sql, params as unknown[])
          )
          return rows as unknown as ReadonlyArray<Row>
        }).pipe(Effect.withSpan("mysql.query", { attributes: { id } })) as never,

      queryWithMeta: (id, connStr, sql, params) =>
        Effect.gen(function* () {
          const pool = yield* acquirePool(poolsRef, id, connStr)
          const start = performance.now()
          const [result, fieldPackets] = yield* handleAsync("queryWithMeta", () =>
            pool.query(sql, params as unknown[])
          )
          const duration = Math.round((performance.now() - start) * 100) / 100
          if (Array.isArray(result) && Array.isArray(fieldPackets)) {
            const rows = result as Record<string, unknown>[]
            const fields = (
              fieldPackets as Array<{ name: string; columnType: number }>
            ).map((f) => ({ name: f.name, dataTypeID: f.columnType ?? 0 }))
            const meta: MySQLQueryResult = {
              rows: rows as ReadonlyArray<Row>,
              fields,
              rowCount: rows.length,
              command: null,
              duration,
            }
            return meta
          }
          const header = result as { affectedRows?: number; insertId?: number }
          const meta: MySQLQueryResult = {
            rows: [],
            fields: null,
            rowCount: header.affectedRows ?? 0,
            command: sql.trim().split(/\s+/)[0]?.toUpperCase() || "QUERY",
            duration,
          }
          return meta
        }).pipe(
          Effect.withSpan("mysql.queryWithMeta", { attributes: { id } })
        ) as never,

      withTx: (id, connStr, f) =>
        Effect.gen(function* () {
          const pool = yield* acquirePool(poolsRef, id, connStr)
          const conn = yield* handleAsync("getConnection", () =>
            pool.getConnection()
          )
          yield* handleAsync("BEGIN", () => conn.beginTransaction())

          const tx: MySQLTx = {
            query: <A extends Row = Row>(
              sql: string,
              params?: ReadonlyArray<unknown>
            ) =>
              handleAsync("tx.query", () =>
                conn
                  .query(sql, params as unknown[])
                  .then(([rows]) => rows as unknown as ReadonlyArray<A>)
              ),
          }

          const result = yield* f(tx).pipe(
            Effect.tapBoth({
              onSuccess: () => handleAsync("COMMIT", () => conn.commit()),
              onFailure: () =>
                handleAsync("ROLLBACK", () => conn.rollback()).pipe(
                  Effect.orElse(() => Effect.void)
                ),
            }),
            Effect.ensuring(Effect.sync(() => conn.release()))
          )
          return result
        }).pipe(Effect.withSpan("mysql.withTx", { attributes: { id } })) as never,

      disconnect: (id) => disconnectPool(poolsRef, id),
    })
  })
)
