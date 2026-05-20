/**
 * ws.WebSocket → WSConnection adapter
 *
 * Wraps the `ws` package's WebSocket into an Effect-friendly WSConnection,
 * so handler code is decoupled from the ws library and listener cleanup is
 * managed automatically.
 *
 * Server-only: must not be imported from the browser bundle.
 */
import { Effect, Stream, PubSub, Scope } from "effect"
import type { WebSocket } from "ws"
import { WSError, type WSProto } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"

/**
 * Wrap a native WebSocket as a WSConnection.
 *
 * Within the caller's Scope:
 * - starts a PubSub that holds every incoming message
 * - takes over WS 'message' / 'close' / 'error'
 * - automatically detaches listeners when the Scope closes
 */
export const fromWebSocket = (
  ws: WebSocket,
  proto: WSProto
): Effect.Effect<WSConnection, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<unknown>()

    // Take over message/close/error; detach on Scope close.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onMessage = (data: unknown) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(String(data))
          } catch {
            parsed = data
          }
          Effect.runFork(PubSub.publish(pubsub, parsed))
        }
        const onClose = () => {
          Effect.runFork(PubSub.shutdown(pubsub))
        }
        const onError = () => {
          Effect.runFork(PubSub.shutdown(pubsub))
        }
        ws.on("message", onMessage)
        ws.on("close", onClose)
        ws.on("error", onError)
        return { onMessage, onClose, onError }
      }),
      (handlers) =>
        Effect.sync(() => {
          ws.off("message", handlers.onMessage)
          ws.off("close", handlers.onClose)
          ws.off("error", handlers.onError)
        })
    )

    const send: WSConnection["send"] = (msg) =>
      Effect.try({
        try: () => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(msg))
          }
        },
        catch: (cause) =>
          new WSError({ proto, kind: "send", cause }),
      })

    const messages: WSConnection["messages"] = Stream.fromPubSub(pubsub)

    const close: WSConnection["close"] = Effect.sync(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    })

    return { send, messages, close } satisfies WSConnection
  })
