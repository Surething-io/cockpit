/**
 * Cross-frame "registry changed" bus over BroadcastChannel.
 *
 * Registry modals run in the Workspace parent frame while chat inputs run in
 * each project's iframe; a BroadcastChannel reaches every same-origin
 * frame/tab with no server round-trip. Each registry gets its own channel so
 * a Bot change never reloads skill autocomplete and vice versa.
 *
 * `inFlightPrefix` names the registry's GET (see `shareInFlight`). A change
 * carries the sender's timestamp, and on receipt any read of that prefix that
 * started *before* the change is no longer joinable, so listeners refreshing on
 * the event never get a pre-change document — yet all of them still share the
 * one post-change request.
 */
import { forgetInFlight } from "@cockpit/effect-core"

export interface ChangeBus {
  /** Tell every frame/tab the registry changed. No-op outside the browser. */
  readonly notify: () => void
  /** Subscribe; returns the unsubscribe function. */
  readonly subscribe: (callback: () => void) => () => void
}

const open = (channel: string): BroadcastChannel | null =>
  typeof window === "undefined" || typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channel)

export const createChangeBus = (channel: string, inFlightPrefix?: string): ChangeBus => ({
  notify: () => {
    const ch = open(channel)
    if (!ch) return
    try {
      ch.postMessage({ type: "changed", at: Date.now() })
    } finally {
      ch.close()
    }
  },
  subscribe: (callback) => {
    const ch = open(channel)
    if (!ch) return () => undefined
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "changed") return
      if (inFlightPrefix) {
        const at = typeof event.data.at === "number" ? event.data.at : Date.now()
        forgetInFlight(inFlightPrefix, at)
      }
      callback()
    }
    ch.addEventListener("message", listener)
    return () => {
      ch.removeEventListener("message", listener)
      ch.close()
    }
  },
})
