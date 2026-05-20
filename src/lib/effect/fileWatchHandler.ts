/**
 * handleFileWatch — Effect-based WebSocket handler for the file-watch channel.
 *
 * - `acquireRelease` wraps the watcher subscriptions so unsubscribe runs on close.
 * - `Schedule.spaced` drives the heartbeat (no setInterval).
 * - The Scope owns all cleanup; `ws.on("close")` is not used directly.
 * - All logging goes through Effect.logInfo / logError, never console.*.
 */
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import {
  ValidationError,
  WSError,
} from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import { fileWatcher, reviewWatcher, type FileEvent } from "../fileWatcher"

const HEARTBEAT = Schedule.spaced("30 seconds")

/**
 * Convert fileWatcher.subscribe (callback-based) into an Effect Stream.
 */
const fileEvents = (
  cwd: string
): Stream.Stream<FileEvent[], never, Scope.Scope> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<FileEvent[]>()
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          fileWatcher.subscribe(cwd, (events) => {
            Effect.runFork(Queue.offer(queue, events))
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
      return Stream.fromQueue(queue)
    })
  )

/**
 * Convert reviewWatcher into a Stream (no payload, notification only).
 */
const reviewEvents: Stream.Stream<void, never, Scope.Scope> = Stream.unwrapScoped(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<void>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        reviewWatcher.subscribe(() => {
          Effect.runFork(Queue.offer(queue, undefined))
        })
      ),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
    return Stream.fromQueue(queue)
  })
)

/**
 * handleFileWatch — Effect entry point.
 */
export const handleFileWatch = (
  conn: WSConnection,
  cwd: string
): Effect.Effect<void, WSError | ValidationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }

    yield* Effect.logInfo("ws/watch start").pipe(
      Effect.annotateLogs("cwd", cwd)
    )

    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // Review notification stream
    yield* Effect.forkScoped(
      reviewEvents.pipe(
        Stream.mapEffect(() =>
          conn.send({ type: "watch", data: [{ type: "review" }] })
        ),
        Stream.runDrain
      )
    )

    // File-change stream (main path, blocking until ws close)
    yield* fileEvents(cwd).pipe(
      Stream.mapEffect((events) =>
        conn.send({ type: "watch", data: events })
      ),
      Stream.runDrain
    )
  }).pipe(Effect.withSpan("ws.handleFileWatch", { attributes: { cwd } }))

// ─────────────────────────────────────────────────────────
// Bridge for wsServer.ts
// ─────────────────────────────────────────────────────────

export const runFileWatchHandler = (ws: WebSocket, cwd: string): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "watch")
      yield* handleFileWatch(conn, cwd)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/watch]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )

  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
