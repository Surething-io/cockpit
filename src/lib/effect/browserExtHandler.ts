/**
 * handleBrowserExt — Effect-based WebSocket handler for /ws/browser-ext.
 *
 * The peer is bin/bridge-host.mjs (the OpenCockpit Bridge native messaging
 * host), relaying for one browser profile's extension. Authentication — the
 * per-boot token — is checked in src/lib/wsServer.ts before this runs.
 *
 * Protocol (extension → server, relayed verbatim by the host):
 *  - { type: "hello", version, browser, protocol }
 *  - { type: "tabs", tabs: [{ fullId, chromeTabId, url, title, allowed, active, projectCwd, origin }] }
 *  - { type: "result", reqId, ok, data?, error?, code? }
 * Server → extension: { type: "cmd" | "open-tab" | "close-tab" | "reload" | "tabs-request", reqId, ... },
 * plus { type: "instance-info", cli } and { type: "tab-ids", cli, ids: { fullId: shortId }, reroll: fullId[] }.
 */
import { Effect, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import type { WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import {
  registerExtension,
  unregisterExtension,
  setExtensionHello,
  syncExtensionTabs,
  dropExtensionTabs,
  resolvePendingRequest,
  cockpitCliName,
  type ReportedTab,
} from "@cockpit/feature-console/server"

const HEARTBEAT = Schedule.spaced("30 seconds")

interface ExtMsg {
  type?: string
  reqId?: unknown
  ok?: unknown
  data?: unknown
  error?: unknown
  code?: unknown
  tabs?: unknown
  browser?: unknown
  version?: unknown
  protocol?: unknown
}

export const handleBrowserExt = (
  conn: WSConnection,
  ws: WebSocket, // Raw ws — the registry sends commands with ws.send
): Effect.Effect<void, WSError, Scope.Scope> =>
  Effect.gen(function* () {
    const extId = yield* Effect.acquireRelease(
      Effect.sync(() => registerExtension(ws)),
      (id) => Effect.sync(() => {
        unregisterExtension(id)
        dropExtensionTabs(id)
      })
    )

    yield* Effect.logInfo("ws/browser-ext connected").pipe(
      Effect.annotateLogs("extId", extId)
    )

    // Tell the extension how users address this server, then ask for the
    // current tab set in case the hello/tabs pair raced the socket.
    yield* conn.send({ type: "instance-info", cli: cockpitCliName() })
    yield* conn.send({ type: "tabs-request" })

    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    yield* conn.messages.pipe(
      Stream.tap((raw) =>
        Effect.suspend(() => {
          const msg = raw as ExtMsg
          switch (msg?.type) {
            case "result":
              if (typeof msg.reqId === "string") {
                resolvePendingRequest(
                  msg.reqId,
                  !!msg.ok,
                  msg.data,
                  typeof msg.error === "string" ? msg.error : undefined,
                  typeof msg.code === "string" ? msg.code : undefined,
                )
              }
              return Effect.void
            case "hello":
              setExtensionHello(extId, msg)
              return Effect.void
            case "tabs": {
              if (!Array.isArray(msg.tabs)) return Effect.void
              // Echo the short ids back for the toolbar badge / "copy" menu, and
              // ask for new ids where one collided with another target.
              const { ids, reroll } = syncExtensionTabs(extId, msg.tabs as ReportedTab[])
              return conn.send({ type: "tab-ids", cli: cockpitCliName(), ids, reroll })
            }
          }
          return Effect.void
        })
      ),
      Stream.runDrain
    )
  }).pipe(
    Effect.withSpan("ws.handleBrowserExt")
  )

// Bridge
export const runBrowserExtHandler = (ws: WebSocket): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "browser-ext")
      yield* handleBrowserExt(conn, ws)
    })
  ).pipe(
    Effect.catchAll((e) =>
      Effect.logError("[ws/browser-ext]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
