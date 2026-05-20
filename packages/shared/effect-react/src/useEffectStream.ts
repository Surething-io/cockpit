/**
 * useEffectStream — subscribe to an Effect Stream and feed the latest value to the component.
 *
 * Replaces:
 * - useEffect + addEventListener + removeEventListener
 * - useEffect + WebSocket onmessage
 * - useEffect + ws / pubsub subscriptions
 *
 * The fiber is interrupted on unmount, providing automatic cleanup.
 */
"use client"

import { useEffect, useState } from "react"
import { Cause, Effect, Fiber, Option, Stream } from "effect"
import { BrowserRuntime, type BrowserContext } from "@cockpit/effect-runtime"

export type StreamState<A, E> =
  | { readonly status: "loading" }
  | { readonly status: "active"; readonly latest: A }
  | { readonly status: "error"; readonly error: E | Cause.Cause<unknown> }
  | { readonly status: "done"; readonly latest: A | undefined }

export function useEffectStream<A, E>(
  stream: Stream.Stream<A, E, BrowserContext>,
  deps: ReadonlyArray<unknown>
): StreamState<A, E> {
  const [state, setState] = useState<StreamState<A, E>>({ status: "loading" })

  useEffect(() => {
    setState({ status: "loading" })

    let latestValue: A | undefined = undefined

    const program = stream.pipe(
      Stream.tap((value) =>
        Effect.sync(() => {
          latestValue = value
          setState({ status: "active", latest: value })
        })
      ),
      Stream.runDrain,
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          const failure = Cause.failureOption(cause)
          const error = Option.isSome(failure)
            ? (failure.value as E)
            : (cause as Cause.Cause<unknown>)
          setState({ status: "error", error })
        })
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          setState({ status: "done", latest: latestValue })
        })
      )
    )

    const fiber = BrowserRuntime.runFork(program)

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}
