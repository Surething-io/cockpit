/**
 * useEffectMutation — Effect triggered by user actions (POST / PUT / DELETE, etc.).
 *
 * Does not run on mount; only runs when mutate(input) is called.
 */
"use client"

import { useCallback, useRef, useState } from "react"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { BrowserRuntime, type BrowserContext } from "@cockpit/effect-runtime"

export type MutationState<A, E> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: A }
  | { readonly status: "error"; readonly error: E | Cause.Cause<unknown> }

export interface MutationResult<A, E, I> {
  readonly state: MutationState<A, E>
  readonly mutate: (input: I) => Promise<Exit.Exit<A, E>>
  readonly reset: () => void
}

export function useEffectMutation<A, E, I>(
  makeEffect: (input: I) => Effect.Effect<A, E, BrowserContext>
): MutationResult<A, E, I> {
  const [state, setState] = useState<MutationState<A, E>>({ status: "idle" })
  const currentFiberRef = useRef<Fiber.RuntimeFiber<A, E> | null>(null)

  const mutate = useCallback(
    async (input: I): Promise<Exit.Exit<A, E>> => {
      // Cancel any in-flight fiber.
      if (currentFiberRef.current) {
        Effect.runFork(Fiber.interrupt(currentFiberRef.current))
      }

      setState({ status: "loading" })

      const fiber = BrowserRuntime.runFork(makeEffect(input))
      currentFiberRef.current = fiber

      const exit = await BrowserRuntime.runPromise(Fiber.join(fiber).pipe(Effect.exit))

      // Only update state if this is still the current fiber (avoid races).
      if (currentFiberRef.current === fiber) {
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
      }

      return exit
    },
    [makeEffect]
  )

  const reset = useCallback(() => {
    if (currentFiberRef.current) {
      Effect.runFork(Fiber.interrupt(currentFiberRef.current))
      currentFiberRef.current = null
    }
    setState({ status: "idle" })
  }, [])

  return { state, mutate, reset }
}
