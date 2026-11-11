import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { forgetInFlight, shareInFlight } from "./inFlight"

/** A fake request that counts calls and resolves when `release()` is called. */
const fakeRequest = <A>(value: A) => {
  let calls = 0
  const pending: Array<() => void> = []
  const effect = Effect.promise(
    () =>
      new Promise<A>((resolve) => {
        calls += 1
        pending.push(() => resolve(structuredClone(value)))
      }),
  )
  return {
    effect,
    calls: () => calls,
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("shareInFlight", () => {
  it("coalesces concurrent identical reads into one request", async () => {
    const req = fakeRequest({ list: [1, 2] })
    const runs = Array.from({ length: 5 }, () => Effect.runPromise(shareInFlight("/a", req.effect)))
    await tick()
    req.release()
    const results = await Promise.all(runs)
    expect(req.calls()).toBe(1)
    expect(results.every((r) => r.list.length === 2)).toBe(true)
  })

  it("gives joiners their own copy", async () => {
    const req = fakeRequest({ list: [1] })
    const first = Effect.runPromise(shareInFlight("/b", req.effect))
    const second = Effect.runPromise(shareInFlight("/b", req.effect))
    await tick()
    req.release()
    const [a, b] = await Promise.all([first, second])
    a.list.push(99)
    expect(b.list).toEqual([1])
  })

  it("is not a cache: a read after settle hits the network again", async () => {
    const req = fakeRequest(1)
    const first = Effect.runPromise(shareInFlight("/c", req.effect))
    await tick()
    req.release()
    await first
    const second = Effect.runPromise(shareInFlight("/c", req.effect))
    await tick()
    req.release()
    await second
    expect(req.calls()).toBe(2)
  })

  it("shares failures too, then forgets them", async () => {
    let calls = 0
    const failing = Effect.suspend(() => {
      calls += 1
      return Effect.fail("boom" as const)
    })
    const exits = await Promise.all([
      Effect.runPromiseExit(shareInFlight("/d", failing)),
      Effect.runPromiseExit(shareInFlight("/d", failing)),
    ])
    expect(exits.every((e) => e._tag === "Failure")).toBe(true)
    await Effect.runPromiseExit(shareInFlight("/d", failing))
    expect(calls).toBe(2)
  })

  it("forgetInFlight makes the next caller start a fresh request", async () => {
    const req = fakeRequest("v")
    const stale = Effect.runPromise(shareInFlight("/e?x=1", req.effect))
    await tick()
    forgetInFlight("/e")
    const fresh = Effect.runPromise(shareInFlight("/e?x=1", req.effect))
    await tick()
    req.release()
    await Promise.all([stale, fresh])
    expect(req.calls()).toBe(2)
  })

  it("forgetInFlight(prefix, at) keeps reads started after the change", async () => {
    const req = fakeRequest("v")
    const before = Effect.runPromise(shareInFlight("/f", req.effect))
    await tick()
    await new Promise((r) => setTimeout(r, 5))
    const changedAt = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    // Several listeners react to the same change event.
    const listeners = Array.from({ length: 3 }, () => {
      forgetInFlight("/f", changedAt)
      return Effect.runPromise(shareInFlight("/f", req.effect))
    })
    await tick()
    req.release()
    await Promise.all([before, ...listeners])
    // One stale read + one shared post-change read.
    expect(req.calls()).toBe(2)
  })
})
