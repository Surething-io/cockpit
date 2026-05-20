/**
 * Neo4jServiceLive — P9 Layer.scoped lifecycle
 * Shares driver creation + runCypher + serialization logic from plugins/neo4j/neo4jCore.
 */
import { Effect, Layer, Ref } from "effect"
import { Driver } from "neo4j-driver"
import { DBError } from "@cockpit/effect-core"
import { Neo4jService, type Row, type Neo4jQueryResult } from "@cockpit/effect-services"
import {
  createNeo4jDriver,
  runCypherWithDriver,
} from "../server/plugins/neo4j/neo4jCore"

interface ManagedDriver {
  driver: Driver
  connectionString: string
  createdAt: number
}

const handleAsync = <A>(
  op: string,
  f: () => Promise<A>
): Effect.Effect<A, DBError> =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new DBError({ db: "neo4j", op, cause }),
  })

const acquireDriver = (
  driversRef: Ref.Ref<Map<string, ManagedDriver>>,
  id: string,
  connectionString: string
): Effect.Effect<Driver, DBError> =>
  Effect.gen(function* () {
    const drivers = yield* Ref.get(driversRef)
    const existing = drivers.get(id)
    if (existing && existing.connectionString === connectionString) {
      return existing.driver
    }
    if (existing) {
      yield* handleAsync("close", () => existing.driver.close()).pipe(
        Effect.orElse(() => Effect.void)
      )
    }
    const driver = yield* handleAsync("createDriver", () =>
      createNeo4jDriver(connectionString)
    )
    yield* Ref.update(driversRef, (m) => {
      const next = new Map(m)
      next.set(id, { driver, connectionString, createdAt: Date.now() })
      return next
    })
    return driver
  })

const disconnectDriver = (
  driversRef: Ref.Ref<Map<string, ManagedDriver>>,
  id: string
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const drivers = yield* Ref.get(driversRef)
    const managed = drivers.get(id)
    if (!managed) return
    yield* handleAsync("disconnect", () => managed.driver.close()).pipe(
      Effect.orElse(() => Effect.void)
    )
    yield* Ref.update(driversRef, (m) => {
      const next = new Map(m)
      next.delete(id)
      return next
    })
  })

export const Neo4jServiceLive = Layer.scoped(
  Neo4jService,
  Effect.gen(function* () {
    const driversRef = yield* Ref.make(new Map<string, ManagedDriver>())

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const drivers = yield* Ref.get(driversRef)
        for (const { driver } of drivers.values()) {
          yield* Effect.tryPromise({
            try: () => driver.close(),
            catch: (cause) =>
              new DBError({ db: "neo4j", op: "shutdown close", cause }),
          }).pipe(Effect.orElse(() => Effect.void))
        }
        yield* Ref.set(driversRef, new Map())
        yield* Effect.logInfo(
          `[Neo4jServiceLive] disposed ${drivers.size} driver(s)`
        )
      })
    )

    return Neo4jService.of({
      run: (id, connStr, cypher, params) =>
        Effect.gen(function* () {
          const driver = yield* acquireDriver(driversRef, id, connStr)
          const result = yield* handleAsync("run", () =>
            runCypherWithDriver(driver, cypher, params)
          )
          return result.records as ReadonlyArray<Row>
        }).pipe(Effect.withSpan("neo4j.run", { attributes: { id } })) as never,

      runWithMeta: (id, connStr, cypher, params) =>
        Effect.gen(function* () {
          const driver = yield* acquireDriver(driversRef, id, connStr)
          const result = yield* handleAsync("runWithMeta", () =>
            runCypherWithDriver(driver, cypher, params)
          )
          const meta: Neo4jQueryResult = {
            records: result.records as ReadonlyArray<Row>,
            keys: result.keys,
            duration: result.duration,
            counters: result.counters,
          }
          return meta
        }).pipe(
          Effect.withSpan("neo4j.runWithMeta", { attributes: { id } })
        ) as never,

      disconnect: (id) => disconnectDriver(driversRef, id),
    })
  })
)
