/**
 * useEffectQuery — run an Effect from a React component and manage its state.
 *
 * Replaces the useEffect + fetch + useState trio.
 * The fiber is interrupted automatically when the component unmounts —
 * equivalent to AbortController.
 */
"use client"

import { useEffect, useState } from "react"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { BrowserRuntime, type BrowserContext } from "@cockpit/effect-runtime"

export type QueryState<A, E> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: A }
  | { readonly status: "error"; readonly error: E | Cause.Cause<unknown> }

export function useEffectQuery<A, E>(
  effect: Effect.Effect<A, E, BrowserContext>,
  deps: ReadonlyArray<unknown>
): QueryState<A, E> {
  const [state, setState] = useState<QueryState<A, E>>({ status: "loading" })

  useEffect(() => {
    setState({ status: "loading" })

    const fiber = BrowserRuntime.runFork(effect)

    fiber.addObserver((exit) => {
      Exit.match(exit, {
        onSuccess: (data) => setState({ status: "success", data }),
        onFailure: (cause) => {
          const failure = Cause.failureOption(cause)
          const error = Option.isSome(failure)
            ? (failure.value as E)
            : (cause as Cause.Cause<unknown>)
          setState({ status: "error", error })
        },
      })
    })

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}
