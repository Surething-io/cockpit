/**
 * Server-only AppRuntime composition — wires in the DB drivers (pg / mysql2 / ioredis / neo4j-driver).
 *
 * Must be imported from `@cockpit/effect-runtime/server`; **never** from the root
 * package (which is the browser bundle entry).
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  LoggerLivePretty,
  LoggerLiveProd,
  TracerLivePretty,
  TracerLiveNoop,
  ConfigLive,
  CockpitConfig,
} from "@cockpit/effect-core"
import {
  PgServiceLive,
  MySQLServiceLive,
  RedisServiceLive,
  Neo4jServiceLive,
  MongoServiceLive,
} from "@cockpit/feature-console/effect"
import {
  SchedulerLive,
  AgentServiceLive,
} from "@cockpit/feature-agent/effect"

const isDev = process.env.COCKPIT_ENV === "dev"

const ServerBaseLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const loggerLayer = isDev ? LoggerLivePretty : LoggerLiveProd(cfg.logFile)
    const tracerLayer = isDev ? TracerLivePretty : TracerLiveNoop
    return Layer.mergeAll(loggerLayer, tracerLayer, ConfigLive)
  })
)

export const AppLayer = Layer.mergeAll(
  ServerBaseLayer,
  // DB services
  PgServiceLive,
  MySQLServiceLive,
  RedisServiceLive,
  Neo4jServiceLive,
  MongoServiceLive,
  // Scheduler
  SchedulerLive,
  // Agent
  AgentServiceLive
)

export type AppContext = Layer.Layer.Success<typeof AppLayer>

export const AppRuntime = ManagedRuntime.make(AppLayer)

let disposed = false
export const disposeAppRuntime = async (): Promise<void> => {
  if (disposed) return
  disposed = true
  await AppRuntime.dispose()
}
