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
import { injectBashSdk, resolveLocalMediaUrl, fromLocalAppUrl, toExternalBrowserAppUrl } from "./htmlBashSdk"

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

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal DOM for the injected script. Only what the SDK actually touches — the
 * call-log panel is built with createElement/appendChild/textContent and read
 * back through `domText`, which is enough to pin what the user ends up seeing.
 */
function fakeEl(tag: string) {
  const style: any = {
    setProperty(k: string, v: string) {
      style[k] = v
    },
  }
  const node: any = {
    tagName: tag,
    style,
    children: [] as any[],
    attrs: {} as Record<string, string>,
    text: "",
    classList: { contains: () => false, toggle() {} },
    listeners: {} as Record<string, Array<(ev: any) => void>>,
    captured: null as number | null,
    setAttribute(k: string, v: string) {
      node.attrs[k] = v
    },
    getAttribute(k: string) {
      return node.attrs[k] ?? null
    },
    addEventListener(type: string, fn: (ev: any) => void) {
      ;(node.listeners[type] ||= []).push(fn)
    },
    setPointerCapture(id: number) {
      node.captured = id
    },
    hasPointerCapture(id: number) {
      return node.captured === id
    },
    releasePointerCapture() {
      node.captured = null
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 36, height: 36 }),
    appendChild(c: any) {
      node.children.push(c)
      return c
    },
    removeChild(c: any) {
      const i = node.children.indexOf(c)
      if (i >= 0) node.children.splice(i, 1)
      return c
    },
    get firstChild() {
      return node.children[0] ?? null
    },
  }
  // Assigning textContent drops existing children, as the real thing does — the
  // panel relies on that nowhere, but a fake that forgets it hides stale rows.
  Object.defineProperty(node, "textContent", {
    get: () => node.text,
    set: (v: string) => {
      node.text = v
      node.children = []
    },
  })
  return node
}

/** Flattened visible text of a fake subtree. */
function domText(node: any): string {
  if (!node) return ""
  return [node.text, ...node.children.map(domText)].filter(Boolean).join(" ")
}

/** Depth-first search for a node matching `pred`. */
function findEl(node: any, pred: (n: any) => boolean): any {
  if (!node) return null
  if (pred(node)) return node
  for (const c of node.children) {
    const hit = findEl(c, pred)
    if (hit) return hit
  }
  return null
}

const byLabel = (root: any, label: string) =>
  findEl(root, (n) => n.attrs["aria-label"] === label)

/** Dispatch to a node's own listeners (no bubbling — handlers under test are
 *  all registered on the dock itself, which is where real events bubble to). */
const fire = (node: any, type: string, ev: any = {}) =>
  (node.listeners[type] || []).forEach((fn: (e: any) => void) => fn(ev))

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
      documentElement: fakeEl("html"),
      // No <meta name="cockpit-theme"> — the theme toggle stays opted out, so
      // the dock here holds the call-log button alone.
      querySelector: () => null,
      createElement: (tag: string) => fakeEl(tag),
      addEventListener() {},
      body: fakeEl("body"),
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
  const body = (ctx as { document: { body: any } }).document.body
  // `raw` for tests that assert on promise settlement; `cockpit` for the rest.
  return { cockpit, raw, sockets, ctx, postMessage, body }
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

/**
 * The dock carries every host button, so a mistake here takes out the theme
 * toggle and the call log at once — which is exactly what happened when the
 * drag was first hoisted off the button and onto the container.
 */
describe("injected SDK — dock", () => {
  /** The dock is the only thing the SDK mounts before a panel is opened. */
  const dockOf = (body: any) => body.children[0]

  const press = (dock: any, btn: any) =>
    fire(dock, "pointerdown", { button: 0, pointerId: 1, clientX: 20, clientY: 20, target: btn })

  const clickEv = (btn: any) => {
    const ev: any = {
      target: btn,
      stopped: false,
      stopPropagation() { ev.stopped = true },
      preventDefault() {},
    }
    return ev
  }

  it("captures the pointer on the pressed button, not on the dock", () => {
    const { body, cockpit } = bootSdk()
    cockpit.bash("echo hi")
    const btn = byLabel(body, "Bash call log")

    press(dockOf(body), btn)
    // Per Pointer Events a click is dispatched to the CAPTURE target, so
    // capturing on the container makes every button inside it dead on click.
    expect(btn.captured).toBe(1)
    expect(dockOf(body).captured).toBe(null)
  })

  it("swallows the click that trails a drag, but never a plain press", () => {
    const { body, cockpit } = bootSdk()
    cockpit.bash("echo hi")
    const dock = dockOf(body)
    const btn = byLabel(body, "Bash call log")

    press(dock, btn)
    fire(dock, "pointerup", { pointerId: 1, target: btn })
    const plain = clickEv(btn)
    fire(dock, "click", plain)
    expect(plain.stopped).toBe(false)

    press(dock, btn)
    fire(dock, "pointermove", {
      pointerId: 1, clientX: 200, clientY: 300, target: btn, preventDefault() {},
    })
    fire(dock, "pointerup", { pointerId: 1, target: btn })
    const afterDrag = clickEv(btn)
    fire(dock, "click", afterDrag)
    expect(afterDrag.stopped).toBe(true)

    // And the next press starts clean — a swallowed click must not leak.
    press(dock, btn)
    fire(dock, "pointerup", { pointerId: 1, target: btn })
    const next = clickEv(btn)
    fire(dock, "click", next)
    expect(next.stopped).toBe(false)
  })
})

/**
 * The call log is what tells a user that a previewed page — which runs with full
 * shell access the moment it is opened — actually ran something. Its value is
 * entirely in being unavoidable and accurate, so these pin both: the button
 * cannot be suppressed by the page, and no command can end up missing or stuck
 * mid-flight in the panel.
 */
describe("injected SDK — bash call log", () => {
  /** Open the log panel and return the whole document's flattened text. */
  const openLog = (body: any) => {
    byLabel(body, "Bash call log").onclick()
    return domText(body)
  }

  it("stays invisible until the page actually calls bash", () => {
    const { body, cockpit } = bootSdk()
    // A page that never shells out gets no chrome at all — not even a container.
    expect(body.children).toHaveLength(0)

    cockpit.bash("echo hi")
    expect(byLabel(body, "Bash call log")).toBeTruthy()
  })

  it("records a call and its outcome", () => {
    const { body, raw, sockets } = bootSdk()
    raw.bash("rm -rf /important").catch(() => {})
    sockets[0].open()
    const id = JSON.parse(sockets[0].sent[0]).id

    // Opened mid-flight: the command is there before it has an outcome.
    const midFlight = openLog(body)
    expect(midFlight).toContain("rm -rf /important")
    expect(midFlight).toContain("running")

    sockets[0].onmessage!({ data: JSON.stringify({ type: "exit", id, code: 3 }) })
    const after = domText(body)
    expect(after).toContain("exit 3")
    expect(after).not.toContain("running")
    expect(after).toContain("Bash calls (1)")
  })

  it("settles a call the connection killed, rather than leaving it running", () => {
    const { body, cockpit, sockets } = bootSdk()
    cockpit.bash("sleep 100")
    sockets[0].open()
    openLog(body)

    sockets[0].readyState = 3
    sockets[0].onclose!()
    expect(domText(body)).toContain("error: connection closed")
  })

  it("marks a killed background job as killed", () => {
    const { raw, body, sockets } = bootSdk()
    const job = (raw as unknown as {
      bash: (c: string, o: unknown) => { kill: () => void }
    }).bash("tail -f log", { background: true })
    sockets[0].open()
    job.kill()
    const shown = openLog(body)
    expect(shown).toContain("killed")
    expect(shown).toContain("background")
  })

  it("follows the host theme on a page that never opted into theming", () => {
    const { body, cockpit, postMessage } = bootSdk()
    cockpit.bash("echo hi")
    openLog(body)
    const panel = findEl(body, (n: any) => !!n.style["--cpk-bg"])

    // No <meta name="cockpit-theme"> here, so there is no .dark class to read —
    // the panel has to take the host's push, or it sits dark on a light page.
    expect(panel.style["--cpk-fg"]).toBe("#1c1c1e")
    postMessage({ type: "THEME_CHANGE", theme: "dark" })
    expect(panel.style["--cpk-fg"]).toBe("#e8e8ea")
    postMessage({ type: "THEME_CHANGE", theme: "light" })
    expect(panel.style["--cpk-fg"]).toBe("#1c1c1e")
  })

  it("clears settled calls on demand but keeps the ones still running", () => {
    const { body, raw, sockets } = bootSdk()
    raw.bash("done-one").catch(() => {})
    raw.bash("still-going").catch(() => {})
    sockets[0].open()
    const doneId = JSON.parse(sockets[0].sent[0]).id
    sockets[0].onmessage!({ data: JSON.stringify({ type: "exit", id: doneId, code: 0 }) })
    openLog(body)

    findEl(body, (n: any) => n.textContent === "Clear").onclick()
    const after = domText(body)
    // Dropping a row for a command that is at this moment executing would make
    // it look like it never happened.
    expect(after).not.toContain("done-one")
    expect(after).toContain("still-going")
    expect(after).toContain("Bash calls (1)")
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

/**
 * Document-relative media refs. These are the cases that decide whether a
 * README's `![](examples/a.jpg)` renders at all: the renderer sees the parsed
 * src with no address of its own, so every one of them is resolved here.
 */
describe("resolveLocalMediaUrl", () => {
  const BASE = "/Users/ka/Work/novel-to-game"

  it("maps a document-relative path to its /apps/local URL", () => {
    expect(resolveLocalMediaUrl("examples/a/title.jpg", BASE)).toBe(
      "/apps/local/Users/ka/Work/novel-to-game/examples/a/title.jpg"
    )
    expect(resolveLocalMediaUrl("./title.jpg", BASE)).toBe(
      "/apps/local/Users/ka/Work/novel-to-game/title.jpg"
    )
  })

  it("collapses `..` — the server rejects a URL that still contains one", () => {
    expect(resolveLocalMediaUrl("../shared/logo.png", BASE)).toBe(
      "/apps/local/Users/ka/Work/shared/logo.png"
    )
    expect(fromLocalAppUrl(resolveLocalMediaUrl("../shared/logo.png", BASE))).toBe(
      "/Users/ka/Work/shared/logo.png"
    )
  })

  it("keeps ?query and #hash out of the encoded filename", () => {
    expect(resolveLocalMediaUrl("logo.png?v=2", BASE)).toBe(
      "/apps/local/Users/ka/Work/novel-to-game/logo.png?v=2"
    )
    expect(resolveLocalMediaUrl("sprite.svg#icon", BASE)).toBe(
      "/apps/local/Users/ka/Work/novel-to-game/sprite.svg#icon"
    )
  })

  it("decodes once so an already-encoded path is not double-encoded", () => {
    expect(resolveLocalMediaUrl("my%20file.png", BASE)).toBe(
      "/apps/local/Users/ka/Work/novel-to-game/my%20file.png"
    )
    expect(resolveLocalMediaUrl("my file.png", BASE)).toBe(
      "/apps/local/Users/ka/Work/novel-to-game/my%20file.png"
    )
  })

  it("leaves refs the browser already resolves untouched", () => {
    for (const src of [
      "https://x.test/a.png",
      "http://x.test/a.png",
      "data:image/png;base64,AAA",
      "//cdn.test/a.png",
      "/absolute/on/origin.png",
      "#anchor-only",
    ]) {
      expect(resolveLocalMediaUrl(src, BASE)).toBe(src)
    }
  })

  it("anchors a relative base to projectRoot, and gives up without one", () => {
    expect(resolveLocalMediaUrl("a.png", "docs", "/Users/ka/proj")).toBe(
      "/apps/local/Users/ka/proj/docs/a.png"
    )
    // No absolute base derivable — leave the browser's own resolution alone
    // rather than emit a URL that is confidently wrong.
    expect(resolveLocalMediaUrl("a.png", "docs")).toBe("a.png")
    expect(resolveLocalMediaUrl("a.png", "")).toBe("a.png")
  })

  it("handles a windows base", () => {
    expect(resolveLocalMediaUrl("img/a.png", "C:\\Users\\ka\\proj")).toBe(
      "/apps/local/C%3A/Users/ka/proj/img/a.png"
    )
  })
})

describe("toExternalBrowserAppUrl", () => {
  it("moves localhost app-runtime URLs onto loopback IP to avoid PWA scope capture", () => {
    expect(
      toExternalBrowserAppUrl(
        "/apps/local/Users/ka/Cherry/07-Skills/weather/index.html",
        "http://localhost:3456"
      )
    ).toBe("http://127.0.0.1:3456/apps/local/Users/ka/Cherry/07-Skills/weather/index.html")

    expect(
      toExternalBrowserAppUrl(
        "/apps/builtin/file-viewer/index.html?file=%2Ftmp%2Fa.md#top",
        "http://localhost:3456"
      )
    ).toBe("http://127.0.0.1:3456/apps/builtin/file-viewer/index.html?file=%2Ftmp%2Fa.md#top")

    expect(
      toExternalBrowserAppUrl(
        "http://localhost:3456/apps/local/tmp/a.html",
        "http://localhost:3456"
      )
    ).toBe("http://127.0.0.1:3456/apps/local/tmp/a.html")
  })

  it("leaves non-app URLs and non-localhost origins untouched", () => {
    expect(toExternalBrowserAppUrl("https://example.com", "http://localhost:3456")).toBe(
      "https://example.com"
    )
    expect(toExternalBrowserAppUrl("/apps/local/tmp/a.html", "http://127.0.0.1:3456")).toBe(
      "http://127.0.0.1:3456/apps/local/tmp/a.html"
    )
  })
})
