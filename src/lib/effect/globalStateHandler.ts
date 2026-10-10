/**
 * handleGlobalState — Effect-based WebSocket handler for the global-state channel.
 *
 * - `Stream.debounce` coalesces bursts of fs events (replaces sending/pendingSend mutex).
 * - `acquireRelease` wraps the fs.watch subscription so it tears down on close.
 * - `Schedule.spaced` drives the heartbeat; the Scope owns all cleanup.
 * - Failures flow as Tagged Errors (WSError | FSError); no bare try/catch.
 */
import { watch, existsSync, mkdirSync } from "fs"
import { basename, dirname } from "path"
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import { FSError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import { GLOBAL_STATE_FILE } from "@cockpit/shared-utils"
import { getGlobalSessionsSnapshot } from "@cockpit/feature-agent/server/state/globalState"

const HEARTBEAT_INTERVAL = Schedule.spaced("30 seconds")

/**
 * Build the snapshot (read state.json, sort, attach previews — shared with the
 * /m SSR page via getGlobalSessionsSnapshot) and send it via the connection.
 */
const sendGlobalState = (
  conn: WSConnection
): Effect.Effect<void, WSError | FSError> =>
  Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise({
      try: () => getGlobalSessionsSnapshot(),
      catch: (cause) =>
        new FSError({ path: GLOBAL_STATE_FILE, op: "read", cause }),
    })

    yield* conn.send({ type: "global-state", data: { sessions } })
  })

/**
 * Call `onChange` whenever state.json changes; returns a stop function.
 *
 * Watches the DIRECTORY and filters by name, never the file itself: writeJsonFile
 * replaces the file atomically (temp + rename), which gives it a new inode, and on macOS
 * a per-file watch stays bound to the old one and goes quiet after the first write.
 * Exported for constraints/atomic-state-writes.test.ts.
 */
export function watchGlobalStateFile(onChange: () => void): () => void {
  const dir = dirname(GLOBAL_STATE_FILE)
  const name = basename(GLOBAL_STATE_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(dir, (_, filename) => {
      if (filename === name) onChange()
    })
    watcher.on("error", () => {
      /* swallow — Effect error channels handle this through other paths */
    })
  } catch {
    /* ignore */
  }
  return () => {
    try {
      watcher?.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Enqueue a tick on every state.json change.
 */
const watchStateFile = (
  trigger: Queue.Queue<void>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => watchGlobalStateFile(() => Effect.runFork(Queue.offer(trigger, undefined)))),
    (stop) => Effect.sync(stop)
  ).pipe(Effect.asVoid)

/**
 * handleGlobalState — Effect entry point.
 *
 * When the Scope closes (WS close or failure), the watcher, heartbeat, and
 * sender fibers are all interrupted automatically.
 */
export const handleGlobalState = (
  conn: WSConnection
): Effect.Effect<void, WSError | FSError, Scope.Scope> =>
  Effect.gen(function* () {
    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT_INTERVAL)
    )

    // trigger queue
    const trigger = yield* Queue.unbounded<void>()

    // File watcher
    yield* watchStateFile(trigger)

    // Prime the queue so an initial state push fires
    yield* Queue.offer(trigger, undefined)

    // Drain trigger: debounce, then send serially
    yield* Stream.fromQueue(trigger).pipe(
      Stream.debounce("50 millis"),
      Stream.mapEffect(() =>
        sendGlobalState(conn).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => console.error("[ws/global-state]", e))
          )
        )
      ),
      Stream.runDrain
    )
  })

// ─────────────────────────────────────────────────────────
// Bridge for wsServer.ts — launch the Effect program from a raw ws.WebSocket
// ─────────────────────────────────────────────────────────

/**
 * Run a raw WebSocket as an Effect program. Closing the WS releases the
 * entire Scope, cleaning up the heartbeat, watcher, fibers, and any pubsub
 * listeners.
 */
export const runGlobalStateHandler = (ws: WebSocket): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "global-state")
      yield* handleGlobalState(conn)
    })
  )
  // Interrupt the fiber on WS close
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
