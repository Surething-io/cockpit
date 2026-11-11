/**
 * Coalesce identical concurrent reads into one network request.
 *
 * Every open chat tab mounts its own Chat, and each Chat (plus every Console
 * bubble badge) loads the same project-wide documents on mount — slash
 * commands, skills, bots, settings, comments, the bubble-order file. A project
 * with 23 tabs fired ~280 identical GETs within 200ms of boot. Routing those
 * reads through `shareInFlight` makes all callers that arrive while a request
 * is still pending await that one request.
 *
 * This is NOT a cache: an entry lives only until its request settles, so the
 * next read after that always hits the server. The only staleness it can add
 * is joining a read that started before a write, which is what `forgetInFlight`
 * is for:
 *   - a client that writes a resource calls `forgetInFlight(prefix)` so the
 *     refresh that follows its write starts a fresh request;
 *   - a cross-frame change notification calls `forgetInFlight(prefix, at)`
 *     with the sender's timestamp, dropping only reads that started before
 *     the change — so N listeners refreshing on the same event still share
 *     the one post-change request instead of each starting their own.
 *
 * Joiners receive a structured clone, never the first caller's object, so one
 * caller mutating its result cannot leak into another. Use it for small JSON
 * documents only.
 *
 * Browser-only in practice: the registry is module state, which on the server
 * would be shared across unrelated requests.
 */
import { Effect, Exit, Runtime } from "effect"

interface Entry {
  readonly startedAt: number
  readonly done: Promise<Exit.Exit<unknown, unknown>>
}

const inFlight = new Map<string, Entry>()

const await_ = <A, E>(entry: Entry): Effect.Effect<A, E> =>
  Effect.flatMap(Effect.promise(() => entry.done), (exit) => exit as Exit.Exit<A, E>)

export const shareInFlight = <A, E>(key: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const existing = inFlight.get(key)
    if (existing) return Effect.map(await_<A, E>(existing), (value) => structuredClone(value))

    return Effect.flatMap(Effect.runtime<never>(), (runtime) => {
      // Run detached so one caller being interrupted does not fail the others.
      const entry: Entry = { startedAt: Date.now(), done: Runtime.runPromiseExit(runtime)(effect) }
      inFlight.set(key, entry)
      void entry.done.then(() => {
        if (inFlight.get(key) === entry) inFlight.delete(key)
      })
      return await_<A, E>(entry)
    })
  })

/**
 * Stop new callers from joining pending reads whose key starts with `prefix`.
 * With `startedBefore`, only reads that began earlier than that epoch-ms
 * timestamp are dropped. Requests already awaited keep running for their
 * current callers.
 */
export const forgetInFlight = (prefix: string, startedBefore = Number.POSITIVE_INFINITY): void => {
  for (const [key, entry] of inFlight) {
    if (key.startsWith(prefix) && entry.startedAt < startedBefore) inFlight.delete(key)
  }
}
