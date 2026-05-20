/**
 * handleTerminalFollow — Effect-based WebSocket handler.
 *
 *   - Both callback-based listeners (output and exit) are wrapped in
 *     acquireRelease.
 *   - The Scope owns all cleanup.
 *   - On exit, the WS is closed through the Effect channel rather than
 *     ad-hoc ws.close calls.
 */
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import {
  ValidationError,
  NotFoundError,
  WSError,
} from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import {
  getTerminalByShortId,
  getRunningCommand,
  addOutputListener,
  addExitListener,
} from "@cockpit/feature-console/server"

const HEARTBEAT = Schedule.spaced("30 seconds")

interface OutputEvent {
  readonly _tag: "output"
  readonly data: string
}
interface ExitEvent {
  readonly _tag: "exit"
  readonly code: number
}
type TerminalEvent = OutputEvent | ExitEvent

const subscribeTerminal = (
  commandId: string
): Stream.Stream<TerminalEvent, never, Scope.Scope> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<TerminalEvent>()
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          addOutputListener(commandId, (data: string) => {
            Effect.runFork(Queue.offer(queue, { _tag: "output", data }))
          })
        ),
        (unsub) => Effect.sync(unsub)
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          addExitListener(commandId, (code: number) => {
            Effect.runFork(Queue.offer(queue, { _tag: "exit", code }))
          })
        ),
        (unsub) => Effect.sync(unsub)
      )
      return Stream.fromQueue(queue)
    })
  )

export const handleTerminalFollow = (
  conn: WSConnection,
  shortId: string
): Effect.Effect<
  void,
  WSError | ValidationError | NotFoundError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    if (!shortId) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }

    const entry = getTerminalByShortId(shortId)
    if (!entry) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "terminal", id: shortId })
      )
    }

    yield* Effect.logInfo("ws/terminal-follow start").pipe(
      Effect.annotateLogs("shortId", shortId),
      Effect.annotateLogs("commandId", entry.commandId)
    )

    // 1. Flush any buffered output first
    const cmd = getRunningCommand(entry.commandId)
    if (cmd) {
      const buffered =
        cmd.outputLines.join("\n") +
        (cmd.outputPartial ? "\n" + cmd.outputPartial : "")
      if (buffered) {
        yield* conn.send({ type: "output", data: buffered })
      }
    }

    // 2. Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // 3. Live output + exit stream; terminate after exit
    yield* subscribeTerminal(entry.commandId).pipe(
      Stream.tap((evt) =>
        evt._tag === "output"
          ? conn.send({ type: "output", data: evt.data })
          : conn.send({ type: "exit", code: evt.code }).pipe(
              Effect.zipRight(conn.close)
            )
      ),
      Stream.takeUntil((evt) => evt._tag === "exit"),
      Stream.runDrain
    )
  }).pipe(
    Effect.withSpan("ws.handleTerminalFollow", {
      attributes: { shortId },
    })
  )

// Bridge for wsServer.ts
export const runTerminalFollowHandler = (
  ws: WebSocket,
  shortId: string
): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "terminal-follow")
      yield* handleTerminalFollow(conn, shortId)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchTag("NotFoundError", () =>
      Effect.sync(() => ws.close(4404, "Terminal not found"))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/terminal-follow]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
