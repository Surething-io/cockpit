/**
 * Regression tests for the injected SDK's WebSocket lifecycle.
 *
 * The SDK ships as a source string, so the tests evaluate the REAL injected
 * script in a vm with a fake WebSocket and drive its lifecycle by hand. Both
 * cases below are about a socket that dies and is replaced — the failure modes
 * are silent (a command re-runs with nobody listening; the bridge wedges with
 * no error), so only an explicit test pins them down.
 */
import { describe, it, expect } from "vitest"
import vm from "vm"
import { injectBashSdk } from "./htmlBashSdk"

/** Fake socket: readyState is driven by the test, sends are recorded. */
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  send(s: string) {
    this.sent.push(s)
  }
  close() {
    this.readyState = 3
  }
  /** Transition to OPEN and fire onopen, as a real socket would. */
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

function bootSdk() {
  const sockets: FakeSocket[] = []
  const html = injectBashSdk("<html><head></head><body></body></html>", {
    cwd: "/tmp",
  })
  const source = html.match(/<script>([\s\S]*?)<\/script>/)![1]

  const messageHandlers: Array<(e: { data: unknown }) => void> = []
  const ctx: Record<string, unknown> = {
    JSON,
    Promise,
    Error,
    Object,
    String,
    encodeURIComponent,
    setTimeout,
    console,
    addEventListener(type: string, fn: (e: { data: unknown }) => void) {
      if (type === "message") messageHandlers.push(fn)
    },
    removeEventListener() {},
    WebSocket: function (this: FakeSocket) {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    location: { protocol: "http:", host: "localhost:3456" },
    document: {
      readyState: "complete",
      documentElement: {
        lang: "",
        classList: { toggle() {} },
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          this.attrs[k] = v
        },
        getAttribute(k: string) {
          return this.attrs[k] ?? null
        },
      },
      querySelector: () => null,
      addEventListener() {},
      body: null,
    },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
  }
  ctx.window = ctx
  ctx.self = ctx
  vm.createContext(ctx)
  vm.runInContext(source, ctx)

  const raw = (ctx as {
    cockpit: { bash: (c: string) => Promise<unknown>; lang: string }
  }).cockpit
  // Foreground bash() rejects when the connection drops — that is the behaviour
  // under test, so swallow it here rather than leaking unhandled rejections.
  const cockpit = {
    bash: (c: string) => raw.bash(c).catch(() => {}),
    get lang() { return raw.lang },
  }
  /** Deliver a postMessage to the SDK's own listeners. */
  const postMessage = (data: unknown) =>
    messageHandlers.forEach((fn) => fn({ data }))
  // `raw` for tests that assert on promise settlement; `cockpit` for the rest.
  return { cockpit, raw, sockets, ctx, postMessage }
}

describe("injected SDK — WebSocket lifecycle", () => {
  it("does not replay a queued command after the connection drops", () => {
    const { cockpit, sockets } = bootSdk()

    // Command issued while the socket is still CONNECTING -> queued.
    cockpit.bash("rm -rf /important")
    expect(sockets).toHaveLength(1)
    expect(sockets[0].sent).toEqual([])

    // Connection dies before it ever opened.
    sockets[0].readyState = 3
    sockets[0].onclose!()

    // A later command opens a fresh socket.
    cockpit.bash("echo second")
    expect(sockets).toHaveLength(2)
    sockets[1].open()

    const commands = sockets[1].sent.map((s) => JSON.parse(s).command)
    expect(commands).toEqual(["echo second"])
    expect(commands).not.toContain("rm -rf /important")
  })

  it("a replaced socket's late close does not wedge its successor", () => {
    const { cockpit, sockets } = bootSdk()

    cockpit.bash("first")
    const sock1 = sockets[0]
    sock1.open()
    expect(sock1.sent.map((s) => JSON.parse(s).command)).toEqual(["first"])

    // sock1 starts closing; ensureWs replaces it rather than waiting.
    sock1.readyState = 2
    cockpit.bash("second")
    expect(sockets).toHaveLength(2)
    const sock2 = sockets[1]
    sock2.open()
    expect(sock2.sent.map((s) => JSON.parse(s).command)).toEqual(["second"])

    // sock1's close arrives AFTER sock2 is live — it must be inert.
    sock1.readyState = 3
    sock1.onclose!()

    // The bridge must still be usable: this goes out immediately, not to a
    // queue that nothing will ever drain.
    cockpit.bash("third")
    expect(sockets).toHaveLength(2) // no third socket
    expect(sock2.sent.map((s) => JSON.parse(s).command)).toEqual([
      "second",
      "third",
    ])
  })

  it("still delivers a replaced socket's late output to its OWN command", async () => {
    const { raw, sockets } = bootSdk()
    const first = raw.bash("first")
    const sock1 = sockets[0]
    sock1.open()
    const id = JSON.parse(sock1.sent[0]).id

    sock1.readyState = 2
    raw.bash("second").catch(() => {})
    sockets[1].open()

    // sock1 legitimately carried "first"; its late frames are the only answer
    // that command will ever get. Dropping them (a blanket generation guard on
    // onmessage) would leave the promise unsettled forever.
    sock1.onmessage!({ data: JSON.stringify({ type: "stdout", id, data: "hi" }) })
    sock1.onmessage!({ data: JSON.stringify({ type: "exit", id, code: 0 }) })
    await expect(first).resolves.toMatchObject({ stdout: "hi", exitCode: 0 })
  })

  it("fails a replaced socket's own commands when it finally closes", async () => {
    const { raw, sockets } = bootSdk()
    const first = raw.bash("first")
    const sock1 = sockets[0]
    sock1.open()

    sock1.readyState = 2
    const second = raw.bash("second")
    sockets[1].open()

    // sock1 dies without answering. It must settle its own command rather than
    // leaving the caller hanging — while NOT disturbing sock2's in-flight work.
    sock1.readyState = 3
    sock1.onclose!()
    await expect(first).rejects.toThrow("connection closed")

    // sock2's command is untouched and still resolvable.
    const id2 = JSON.parse(sockets[1].sent[0]).id
    sockets[1].onmessage!({ data: JSON.stringify({ type: "exit", id: id2, code: 7 }) })
    await expect(second).resolves.toMatchObject({ exitCode: 7 })
  })
})

describe("injected SDK — language", () => {
  it("parks the host's language push on a dedicated attribute", () => {
    const { cockpit, postMessage, ctx } = bootSdk()
    // Nothing pushed yet: apps fall back to navigator themselves.
    expect(cockpit.lang).toBe("")

    postMessage({ type: "cockpit:language-change", lang: "zh" })
    // Parked in the DOM, so a bundle that loads LATER can still read it —
    // this is the whole point: the push is one-shot, the attribute is not.
    expect(cockpit.lang).toBe("zh")
    // A dedicated attribute, so a page's own <html lang="en"> cannot be
    // mistaken for "the host told us" (which would kill the navigator fallback).
    const doc = (ctx as { document: { documentElement: { lang: string } } }).document
    expect(doc.documentElement.lang).toBe("zh")

    postMessage({ type: "cockpit:language-change", lang: "en" })
    expect(cockpit.lang).toBe("en")
  })

  it("ignores unrelated messages and a missing lang", () => {
    const { cockpit, postMessage } = bootSdk()
    postMessage({ type: "THEME_CHANGE", theme: "dark" })
    postMessage({ type: "cockpit:language-change" })
    expect(cockpit.lang).toBe("")
  })
})
