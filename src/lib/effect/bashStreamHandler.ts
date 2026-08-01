/**
 * handleBash — Effect-based WebSocket handler for the HTML-preview bash SDK.
 *
 * Backs `window.cockpit.bash(command, { background, ... })` injected into the
 * sandboxed HTML preview iframe. One WS per iframe; multiple concurrent commands
 * are multiplexed by a client-generated call `id`.
 *
 * Deliberately self-contained: it spawns child processes directly and does NOT
 * go through console's RunningCommandRegistry. registerCommand persists a
 * terminal-history JSONL placeholder and broadcasts a console bubble delta —
 * routing an AI page's curl calls through it would pollute the user's terminal
 * history. Here every spawn is tracked in a local Map, streamed back tagged by
 * `id`, and killed when the connection's Scope closes.
 *
 * Wire protocol (message verbs are actions, not the tool name):
 *   client → server: { type: "exec", id, command, cwd? } | { type: "kill", id }
 *   server → client: { type: "stdout"|"stderr", id, data }
 *                    { type: "exit", id, code } | { type: "error", id, message }
 *
 * Security: same posture as /api/bash — this is an RCE channel. The WS upgrade
 * is covered by server.mjs's token gate (open when no --token, cookie-gated when
 * set); this handler adds no auth of its own.
 */
import { spawn, type ChildProcess } from "child_process"
import { Effect, Scope, Schedule, Stream } from "effect"
import type { WebSocket } from "ws"
import { ValidationError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import { sanitizedSpawnEnv } from "@cockpit/shared-utils"
import { resolveBashShell, killProcessTree } from "../shell"

const HEARTBEAT = Schedule.spaced("30 seconds")

/** Kill the child's whole process tree (cross-platform). */
function killChild(child: ChildProcess): void {
  killProcessTree(child)
}

export const handleBash = (
  conn: WSConnection,
  defaultCwd: string | undefined
): Effect.Effect<void, WSError | ValidationError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.logInfo("ws/bash start").pipe(
      Effect.annotateLogs("cwd", defaultCwd ?? "")
    )

    // Track live children so the Scope finalizer can reap them all on close.
    const children = new Map<string, ChildProcess>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const child of children.values()) killChild(child)
        children.clear()
      })
    )

    // bash for `--login -c`. On Windows this is Git Bash / WSL; null means none
    // is installed → report a clear error rather than spawning `cmd --login -c`.
    const shell = resolveBashShell()

    const startExec = (msg: Record<string, unknown>): void => {
      const id = msg.id as string
      const command = msg.command as string
      const cwd = (msg.cwd as string | undefined) || defaultCwd || process.cwd()

      if (!id || typeof id !== "string") return
      if (!shell) {
        Effect.runFork(
          conn.send({
            type: "error",
            id: id || "",
            message: "bash not found — install Git Bash or WSL on Windows",
          })
        )
        return
      }
      if (!command || typeof command !== "string") {
        Effect.runFork(
          conn.send({ type: "error", id: id || "", message: "missing command" })
        )
        return
      }

      // Reject a reused in-flight id: overwriting the Map entry would orphan the
      // previous child (finalizer can't reap it) and let its later `close`
      // delete the new child's entry.
      if (children.has(id)) {
        Effect.runFork(
          conn.send({ type: "error", id, message: "duplicate command id" })
        )
        return
      }

      let child: ChildProcess
      try {
        child = spawn(shell, ["--login", "-c", command], {
          cwd,
          env: sanitizedSpawnEnv({ FORCE_COLOR: "0" }),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        })
      } catch (e) {
        Effect.runFork(
          conn.send({ type: "error", id, message: (e as Error).message })
        )
        return
      }

      // Attach listeners IMMEDIATELY after spawn. A spawn failure (missing cwd,
      // missing shell) is NOT thrown synchronously — Node delivers it via an
      // async 'error' event with child.pid === undefined. If we returned early
      // on `!child.pid` *before* attaching child.on('error'), that 'error' event
      // would have no listener and Node would rethrow it as an uncaughtException,
      // crashing the whole server. So we register the error handler first and let
      // it report the failure back to the page.
      children.set(id, child)

      child.stdout?.on("data", (d: Buffer) => {
        Effect.runFork(conn.send({ type: "stdout", id, data: d.toString() }))
      })
      child.stderr?.on("data", (d: Buffer) => {
        Effect.runFork(conn.send({ type: "stderr", id, data: d.toString() }))
      })
      child.on("close", (code: number | null) => {
        if (children.get(id) === child) children.delete(id)
        Effect.runFork(conn.send({ type: "exit", id, code: code ?? 0 }))
      })
      child.on("error", (err: Error) => {
        if (children.get(id) === child) children.delete(id)
        Effect.runFork(conn.send({ type: "error", id, message: err.message }))
      })
    }

    const dispatch = (raw: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        const msg = raw as Record<string, unknown>
        const type = msg.type as string
        if (type === "exec") {
          startExec(msg)
        } else if (type === "kill") {
          const id = msg.id as string
          const child = children.get(id)
          if (child) {
            children.delete(id)
            killChild(child)
          }
        }
      })

    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // Main message loop — completes when the WS closes (PubSub shuts down),
    // then the Scope finalizer reaps any remaining children.
    yield* conn.messages.pipe(
      Stream.mapEffect(dispatch),
      Stream.runDrain
    )
  }).pipe(Effect.withSpan("ws.handleBash", { attributes: { cwd: defaultCwd ?? "" } }))

// Bridge for wsServer.ts
export const runBashHandler = (
  ws: WebSocket,
  cwd: string | undefined
): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "bash")
      yield* handleBash(conn, cwd)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/bash]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
