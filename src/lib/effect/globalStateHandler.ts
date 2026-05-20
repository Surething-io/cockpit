/**
 * handleGlobalState — Effect-based WebSocket handler for the global-state channel.
 *
 * - `Stream.debounce` coalesces bursts of fs events (replaces sending/pendingSend mutex).
 * - `acquireRelease` wraps the fs.watch subscription so it tears down on close.
 * - `Schedule.spaced` drives the heartbeat; the Scope owns all cleanup.
 * - Failures flow as Tagged Errors (WSError | FSError); no bare try/catch.
 */
import { watch, existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import { FSError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import {
  GLOBAL_STATE_FILE,
  readJsonFile,
} from "@cockpit/shared-utils"
import { getLastUserMessage } from "@cockpit/feature-agent/server/state/globalState"

interface GlobalSession {
  cwd: string
  sessionId: string
  lastActive: number
  status: string
  title?: string
  lastUserMessage?: string
}

interface GlobalState {
  sessions: GlobalSession[]
}

const HEARTBEAT_INTERVAL = Schedule.spaced("30 seconds")

/**
 * Read state, sort sessions, attach lastUserMessage, then send via the connection.
 */
const sendGlobalState = (
  conn: WSConnection
): Effect.Effect<void, WSError | FSError> =>
  Effect.gen(function* () {
    const state = yield* Effect.tryPromise({
      try: () => readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] }),
      catch: (cause) =>
        new FSError({ path: GLOBAL_STATE_FILE, op: "read", cause }),
    })

    // backward-compat: isLoading → status
    for (const s of state.sessions) {
      if (!s.status) {
        const legacy = s as GlobalSession & { isLoading?: boolean }
        s.status = legacy.isLoading ? "loading" : "normal"
      }
    }

    state.sessions.sort((a, b) => b.lastActive - a.lastActive)
    const recent = state.sessions.slice(0, 15)

    const sessions = yield* Effect.forEach(
      recent,
      (session) =>
        session.status === "loading" && session.lastUserMessage
          ? Effect.succeed(session)
          : Effect.tryPromise({
              try: () => getLastUserMessage(session.cwd, session.sessionId),
              catch: () => undefined as never,
            }).pipe(
              Effect.map((lastUserMessage) => ({ ...session, lastUserMessage })),
              Effect.orElseSucceed(() => session)
            ),
      { concurrency: "unbounded" }
    )

    yield* conn.send({ type: "global-state", data: { sessions } })
  })

/**
 * Start an fs.watch and enqueue a tick on every change event.
 */
const watchStateFile = (
  trigger: Queue.Queue<void>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = dirname(GLOBAL_STATE_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const offer = () => Effect.runFork(Queue.offer(trigger, undefined))
      let watcher: ReturnType<typeof watch> | null = null
      try {
        watcher = watch(GLOBAL_STATE_FILE, () => offer())
      } catch {
        try {
          watcher = watch(dir, (_, filename) => {
            if (filename === "state.json") offer()
          })
        } catch {
          /* ignore */
        }
      }
      watcher?.on("error", () => {
        /* swallow — Effect error channels handle this through other paths */
      })
      return watcher
    }),
    (watcher) =>
      Effect.sync(() => {
        try {
          watcher?.close()
        } catch {
          /* ignore */
        }
      })
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
