/**
 * IframeBus — cross-iframe message bus (browser side)
 *
 * Replaces the 20+ hard-coded window.parent.postMessage /
 * window.addEventListener("message") call sites.
 *
 * Live implementation lives in packages/shared/effect-runtime/src/browser/
 */
import { Context, Effect, Stream, Scope } from "effect"

/**
 * Topic<T> — a typed message channel.
 *
 * - id: stable kebab-case routing key (used by the Effect side).
 * - legacyType: v1-style SCREAMING_SNAKE_CASE. IframeBusLive uses it to emit
 *   v1-compatible `window.postMessage({ type: legacyType, ...msg })`, so v1
 *   listeners and v2 publishers can coexist during migration.
 */
export interface Topic<T> {
  readonly id: string
  readonly legacyType: string
  readonly _phantom?: T
}

const toLegacy = (id: string): string =>
  id.replace(/-/g, "_").toUpperCase()

export const defineTopic = <T>(
  id: string,
  legacyType?: string
): Topic<T> =>
  ({ id, legacyType: legacyType ?? toLegacy(id) }) as Topic<T>

export interface IframeBus {
  /** Publish a message to the parent or child iframe. */
  readonly publish: <T>(topic: Topic<T>, msg: T) => Effect.Effect<void>

  /** Subscribe to a topic; unsubscribes automatically when the Scope closes. */
  readonly subscribe: <T>(
    topic: Topic<T>
  ) => Stream.Stream<T, never, Scope.Scope>
}

export const IframeBus = Context.GenericTag<IframeBus>("@cockpit/IframeBus")
