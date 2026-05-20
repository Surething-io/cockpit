/**
 * IframeBusLive — browser-side IframeBus implementation
 *
 * Dual message model (migration period):
 * - publish: emits both the v1 compatibility shape `{ type: legacyType, ...msg }`
 *   and the v2 shape `{ topic, msg }` — v1 listeners still receive it, and
 *   v2 subscribers receive it too.
 * - subscribe: recognizes both v1 and v2 shapes (matches by topic.id or topic.legacyType).
 *
 * Once all v1 listeners are migrated to IframeBus.subscribe in a later phase,
 * the v1 compatibility path can be removed.
 */
import { Effect, Layer, PubSub, Scope, Stream } from "effect"
import { IframeBus, type Topic } from "@cockpit/effect-services"

interface BusEnvelope {
  readonly topic: string
  readonly msg: unknown
}

const matchesTopic = (data: unknown, topic: Topic<unknown>): boolean => {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  // v2 style: { topic: "view-change", msg: { ... } }
  if (d.topic === topic.id) return true
  // v1 style: { type: "VIEW_CHANGE", ...msg }
  if (d.type === topic.legacyType) return true
  return false
}

const extractMsg = <T>(data: unknown, topic: Topic<T>): T => {
  const d = data as Record<string, unknown>
  if (d.topic === topic.id) return d.msg as T
  // v1 style: topic.legacyType is the message `type`, payload lives at the root;
  // strip the `type` field before returning.
  const { type: _ignore, ...rest } = d
  return rest as T
}

export const IframeBusLive = Layer.scoped(
  IframeBus,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<MessageEvent>()

    // Take over window 'message'; detach on Scope close.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handler = (e: MessageEvent): void => {
          Effect.runFork(PubSub.publish(pubsub, e))
        }
        if (typeof window !== "undefined") {
          window.addEventListener("message", handler)
        }
        return handler
      }),
      (handler) =>
        Effect.sync(() => {
          if (typeof window !== "undefined") {
            window.removeEventListener("message", handler)
          }
        })
    )

    return IframeBus.of({
      publish: <T>(topic: Topic<T>, msg: T) =>
        Effect.sync(() => {
          if (typeof window === "undefined") return
          // Emit v1 + v2 simultaneously (merged into one message to save calls).
          const payload = {
            type: topic.legacyType,
            topic: topic.id,
            msg,
            ...(typeof msg === "object" && msg !== null ? msg : {}),
          }
          window.parent.postMessage(payload, "*")
        }),

      subscribe: <T>(topic: Topic<T>) =>
        Stream.fromPubSub(pubsub).pipe(
          Stream.filter((e) => matchesTopic(e.data, topic as Topic<unknown>)),
          Stream.map((e) => extractMsg(e.data, topic))
        ) satisfies Stream.Stream<T, never, Scope.Scope>,
    })
  })
)
