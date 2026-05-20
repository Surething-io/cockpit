/**
 * PgServiceLive — Layer.scoped lifecycle.
 *
 * Layer.scoped owns a Ref<Map<id, pool>> with a process-level finalizer that
 * closes every pool on Scope close.
 *
 * Dual-track coexistence:
 *   - PgService Tag (this file's Live) is the new path with full Scope/Fiber
 *     lifecycle management.
 *   - The `pgPoolManager` singleton (plugins/database/PgPoolManager.ts) is the
 *     legacy path that the existing API routes still import directly; do not
 *     remove it in this pass.
 *
 * Next pass: migrate the db/* routes onto PgService, then delete the
 * globalThis singleton.
 */
import { Effect, Layer, Ref, Stream } from "effect"
import pg from "pg"
import { DBError } from "@cockpit/effect-core"
import { PgService, type PgTx, type Row, type PgQueryResult } from "@cockpit/effect-services"

const { Pool } = pg
type PoolInstance = InstanceType<typeof Pool>

interface ManagedPool {
  pool: PoolInstance
  connectionString: string
  createdAt: number
}

const handleAsync = <A>(
  op: string,
  f: () => Promise<A>
): Effect.Effect<A, DBError> =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new DBError({ db: "pg", op, cause }),
  })

const acquirePool = (
  poolsRef: Ref.Ref<Map<string, ManagedPool>>,
  id: string,
  connectionString: string
): Effect.Effect<PoolInstance, DBError> =>
  Effect.gen(function* () {
    const pools = yield* Ref.get(poolsRef)
    const existing = pools.get(id)
    if (existing && existing.connectionString === connectionString) {
      return existing.pool
    }
    // Connection string changed or no existing entry -> close old then build new
    if (existing) {
      yield* handleAsync("end", () => existing.pool.end()).pipe(
        Effect.orElse(() => Effect.void)
      )
    }
    const pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 10000,
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

export const PgServiceLive = Layer.scoped(
  PgService,
  Effect.gen(function* () {
    const poolsRef = yield* Ref.make(new Map<string, ManagedPool>())

    // On Scope close (runtime dispose / process exit), close any pools still open
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pools = yield* Ref.get(poolsRef)
        for (const { pool } of pools.values()) {
          yield* Effect.tryPromise({
            try: () => pool.end(),
            catch: (cause) => new DBError({ db: "pg", op: "shutdown end", cause }),
          }).pipe(Effect.orElse(() => Effect.void))
        }
        yield* Ref.set(poolsRef, new Map())
        yield* Effect.logInfo(
          `[PgServiceLive] disposed ${pools.size} pool(s)`
        )
      })
    )

    return PgService.of({
      query: (id, connStr, sql, params) =>
        Effect.gen(function* () {
          const pool = yield* acquirePool(poolsRef, id, connStr)
          const result = yield* handleAsync("query", () =>
            pool.query(sql, params as unknown[])
          )
          return result.rows as ReadonlyArray<Row>
        }).pipe(Effect.withSpan("pg.query", { attributes: { id } })) as never,

      queryWithMeta: (id, connStr, sql, params) =>
        Effect.gen(function* () {
          const pool = yield* acquirePool(poolsRef, id, connStr)
          const start = performance.now()
          const result = yield* handleAsync("queryWithMeta", () =>
            pool.query(sql, params as unknown[])
          )
          const duration = Math.round((performance.now() - start) * 100) / 100
          const meta: PgQueryResult = {
            rows: (result.rows ?? []) as ReadonlyArray<Row>,
            fields: result.fields
              ? result.fields.map(
                  (f: { name: string; dataTypeID: number }) => ({
                    name: f.name,
                    dataTypeID: f.dataTypeID,
                  })
                )
              : null,
            rowCount: result.rowCount ?? null,
            command: result.command ?? null,
            duration,
          }
          return meta
        }).pipe(
          Effect.withSpan("pg.queryWithMeta", { attributes: { id } })
        ) as never,

      stream: <A extends Row = Row>(
        id: string,
        connStr: string,
        sql: string,
        params?: ReadonlyArray<unknown>
      ): Stream.Stream<A, DBError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const pool = yield* acquirePool(poolsRef, id, connStr)
            const result = yield* handleAsync("query", () =>
              pool.query(sql, params as unknown[])
            )
            return Stream.fromIterable(result.rows as A[])
          })
        ),

      withTx: (id, connStr, f) =>
        Effect.gen(function* () {
          const pool = yield* acquirePool(poolsRef, id, connStr)
          const client = yield* handleAsync("connect", () => pool.connect())
          yield* handleAsync("BEGIN", () => client.query("BEGIN"))

          const tx: PgTx = {
            query: <A extends Row = Row>(
              sql: string,
              params?: ReadonlyArray<unknown>
            ) =>
              handleAsync("tx.query", () =>
                client
                  .query(sql, params as unknown[])
                  .then((r) => r.rows as ReadonlyArray<A>)
              ),
          }

          const result = yield* f(tx).pipe(
            Effect.tapBoth({
              onSuccess: () =>
                handleAsync("COMMIT", () => client.query("COMMIT")),
              onFailure: () =>
                handleAsync("ROLLBACK", () =>
                  client.query("ROLLBACK")
                ).pipe(Effect.orElse(() => Effect.void)),
            }),
            Effect.ensuring(Effect.sync(() => client.release()))
          )
          return result
        }).pipe(Effect.withSpan("pg.withTx", { attributes: { id } })) as never,

      disconnect: (id) => disconnectPool(poolsRef, id),
    })
  })
)
