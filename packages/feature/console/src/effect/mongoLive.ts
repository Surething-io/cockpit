/**
 * MongoServiceLive — placeholder implementation.
 *
 * The mongodb driver is not in package.json. This Live keeps the full
 * interface, with every method returning DBError(op="not-implemented"),
 * so the implementation can be swapped in seamlessly once the mongodb
 * package is added.
 */
import { Effect, Layer } from "effect"
import { DBError } from "@cockpit/effect-core"
import { MongoService } from "@cockpit/effect-services"

const notImpl = <A>(op: string): Effect.Effect<A, DBError> =>
  Effect.fail(
    new DBError({
      db: "mongo",
      op,
      cause: new Error("MongoServiceLive not implemented (mongodb driver not installed)"),
    })
  )

export const MongoServiceLive = Layer.succeed(
  MongoService,
  MongoService.of({
    find: () => notImpl("find"),
    command: () => notImpl("command"),
    disconnect: () => Effect.void, // No connection, disconnect is a no-op
  })
)
