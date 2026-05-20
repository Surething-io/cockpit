/**
 * handleBrowser — Effect-based WebSocket handler.
 *
 * Protocol:
 *  - On register, reply with { type: "registered", shortId }.
 *  - The client sends { type: "browser:cmd-result", reqId, ok, data?, error? }
 *    which is forwarded to resolvePendingRequest.
 *
 * Implementation notes:
 *  - registerBrowser still needs the raw ws.WebSocket because other modules
 *    push messages directly via ws.send, so it is passed in.
 *  - Heartbeat, message dispatch, and close cleanup are all Effect-managed.
 */
import { Effect, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import { ValidationError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import {
  registerBrowser,
  unregisterBrowser,
  resolvePendingRequest,
} from "@cockpit/feature-console/server"

const HEARTBEAT = Schedule.spaced("30 seconds")

interface CmdResultMsg {
  type: "browser:cmd-result"
  reqId: string
  ok: boolean
  data?: unknown
  error?: string
}

export const handleBrowser = (
  conn: WSConnection,
  ws: WebSocket, // Raw ws — registerBrowser needs it so other modules can ws.send
  fullId: string
): Effect.Effect<void, WSError | ValidationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!fullId) {
      return yield* Effect.fail(
        new ValidationError({ field: "fullId", reason: "missing" })
      )
    }

    // Register and notify the client (acquireRelease ensures unregister on close)
    const shortId = yield* Effect.acquireRelease(
      Effect.sync(() => registerBrowser(fullId, ws)),
      () => Effect.sync(() => unregisterBrowser(fullId))
    )

    yield* Effect.logInfo("ws/browser registered").pipe(
      Effect.annotateLogs("fullId", fullId),
      Effect.annotateLogs("shortId", shortId)
    )

    yield* conn.send({ type: "registered", shortId })

    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // Main message loop
    yield* conn.messages.pipe(
      Stream.tap((raw) =>
        Effect.sync(() => {
          const msg = raw as Partial<CmdResultMsg>
          if (msg?.type === "browser:cmd-result" && typeof msg.reqId === "string") {
            resolvePendingRequest(msg.reqId, !!msg.ok, msg.data, msg.error)
          }
        })
      ),
      Stream.runDrain
    )
  }).pipe(
    Effect.withSpan("ws.handleBrowser", { attributes: { fullId } })
  )

// Bridge
export const runBrowserHandler = (ws: WebSocket, fullId: string): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "browser")
      yield* handleBrowser(conn, ws, fullId)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/browser]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
