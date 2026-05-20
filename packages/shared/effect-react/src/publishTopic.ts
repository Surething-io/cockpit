/**
 * publishTopic — convenience helper for React components and hooks.
 *
 * Replaces the boilerplate
 * `BrowserRuntime.runFork(Effect.flatMap(IframeBus, (b) => b.publish(...)))`
 * so each call site only needs a single line.
 *
 * Usage:
 *   publishTopic(Topics.OpenProject, { cwd, sessionId })
 */
"use client"

import { Effect } from "effect"
import { IframeBus, type Topic } from "@cockpit/effect-services"
import { BrowserRuntime } from "@cockpit/effect-runtime"

export const publishTopic = <T>(topic: Topic<T>, msg: T): void => {
  BrowserRuntime.runFork(
    Effect.flatMap(IframeBus, (bus) => bus.publish(topic, msg))
  )
}
