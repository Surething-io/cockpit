/**
 * handleTerminal — Effect-based WebSocket handler (the most complex handler).
 *
 *   - Scope.addFinalizer owns every listener cleanup; everything is released
 *     when the fiber is interrupted.
 *   - Stream.mapEffect replaces the imperative ws.on('message') dispatcher.
 *   - Heartbeat is driven by Schedule.spaced and cancels automatically.
 *   - Spawn / attach / signal / resize semantics match the original handler.
 */
import { spawn, execSync, type ChildProcess } from "child_process"
import * as nodePty from "node-pty"
import { Effect, Scope, Schedule, Stream } from "effect"
import type { WebSocket } from "ws"
import { ValidationError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import {
  registerCommand,
  finalizeCommand,
  getRunningCommands,
  getRunningCommand,
  getRegistrySize,
  getAllProjectCwds,
  findSafeStart,
} from "@cockpit/feature-console/server"
import {
  isWindows,
  getDefaultShell,
  getDefaultPath,
} from "@cockpit/shared-utils"

const HEARTBEAT = Schedule.spaced("30 seconds")

// ─────────────────────────────────────────────────────────
// helper: descendant pids
// ─────────────────────────────────────────────────────────

function getDescendantPids(pid: number): number[] {
  const descendants: number[] = []
  function collect(parentPid: number) {
    try {
      let result: string
      if (isWindows) {
        result = execSync(
          `wmic process where (ParentProcessId=${parentPid}) get ProcessId /format:list`,
          { encoding: "utf-8", timeout: 3000 }
        ).trim()
        const childPids = result
          .split("\n")
          .map((l) => l.replace(/\r/, "").match(/ProcessId=(\d+)/)?.[1])
          .filter(Boolean)
          .map(Number)
        for (const cp of childPids) {
          collect(cp)
          descendants.push(cp)
        }
      } else {
        result = execSync(`pgrep -P ${parentPid}`, {
          encoding: "utf-8",
          timeout: 3000,
        }).trim()
        const childPids = result.split("\n").filter(Boolean).map(Number)
        for (const cp of childPids) {
          collect(cp)
          descendants.push(cp)
        }
      }
    } catch {
      /* no children */
    }
  }
  collect(pid)
  return descendants
}

// ─────────────────────────────────────────────────────────
// Per-connection cleanup registry
// ─────────────────────────────────────────────────────────

interface CleanupRegistry {
  /** Register a cleanup for the given commandId on the Scope; any previous cleanup runs first. */
  attach: (commandId: string, cleanup: () => void) => Effect.Effect<void>
  /** Eagerly release the cleanup associated with a commandId. */
  detach: (commandId: string) => Effect.Effect<void>
}

const makeCleanupRegistry = (): Effect.Effect<CleanupRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const map = new Map<string, () => void>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const f of map.values()) f()
        map.clear()
      })
    )
    return {
      attach: (commandId, cleanup) =>
        Effect.sync(() => {
          const old = map.get(commandId)
          if (old) old()
          map.set(commandId, cleanup)
        }),
      detach: (commandId) =>
        Effect.sync(() => {
          const old = map.get(commandId)
          if (old) {
            old()
            map.delete(commandId)
          }
        }),
    }
  })

// ─────────────────────────────────────────────────────────
// listener attach — registers cleanups through the registry
// ─────────────────────────────────────────────────────────

const attachPipeListeners = (
  registry: CleanupRegistry,
  send: (msg: Record<string, unknown>) => Effect.Effect<void, WSError>,
  commandId: string,
  child: ChildProcess
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const onStdout = (data: Buffer) => {
      Effect.runFork(send({ type: "stdout", commandId, data: data.toString() }))
    }
    const onStderr = (data: Buffer) => {
      Effect.runFork(send({ type: "stderr", commandId, data: data.toString() }))
    }
    const pid = child.pid
    const onClose = async (code: number | null) => {
      const exitCode = code ?? 0
      Effect.runFork(send({ type: "exit", commandId, code: exitCode }))
      try {
        await finalizeCommand(commandId, exitCode, pid)
      } catch (e) {
        Effect.runFork(
          Effect.logError("[ws/terminal] finalize error").pipe(
            Effect.annotateLogs("error", String(e))
          )
        )
      }
      Effect.runFork(registry.detach(commandId))
    }
    const onError = async (error: Error) => {
      Effect.runFork(send({ type: "error", commandId, error: error.message }))
      try {
        await finalizeCommand(commandId, 1, pid)
      } catch {
        /* swallow */
      }
      Effect.runFork(registry.detach(commandId))
    }

    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.on("close", onClose)
    child.on("error", onError)

    yield* registry.attach(commandId, () => {
      child.stdout?.off("data", onStdout)
      child.stderr?.off("data", onStderr)
      child.off("close", onClose)
      child.off("error", onError)
    })
  })

const attachPtyListeners = (
  registry: CleanupRegistry,
  send: (msg: Record<string, unknown>) => Effect.Effect<void, WSError>,
  commandId: string,
  pty: nodePty.IPty
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dataDisposable = pty.onData((data: string) => {
      Effect.runFork(send({ type: "stdout", commandId, data }))
    })
    const ptyPid = pty.pid
    const exitDisposable = pty.onExit(async ({ exitCode }) => {
      Effect.runFork(send({ type: "exit", commandId, code: exitCode }))
      try {
        await finalizeCommand(commandId, exitCode, ptyPid)
      } catch (e) {
        Effect.runFork(
          Effect.logError("[ws/terminal] finalize error").pipe(
            Effect.annotateLogs("error", String(e))
          )
        )
      }
      Effect.runFork(registry.detach(commandId))
    })

    yield* registry.attach(commandId, () => {
      dataDisposable.dispose()
      exitDisposable.dispose()
    })
  })

// ─────────────────────────────────────────────────────────
// Message dispatcher (6 message types)
// ─────────────────────────────────────────────────────────

const dispatchMessage = (
  msg: Record<string, unknown>,
  projectCwd: string,
  registry: CleanupRegistry,
  send: (m: Record<string, unknown>) => Effect.Effect<void, WSError>
): Effect.Effect<void> =>
  Effect.sync(() => {
    const type = msg.type as string

    if (type === "exec") {
      const { commandId, command, cwd, tabId, env, usePty, cols, rows } =
        msg as {
          commandId: string
          command: string
          cwd: string
          tabId: string
          env?: Record<string, string>
          usePty?: boolean
          cols?: number
          rows?: number
        }

      if (!commandId || !command || !cwd || !tabId) {
        Effect.runFork(
          send({
            type: "error",
            commandId: commandId || "",
            error: "Missing required parameters",
          })
        )
        return
      }

      const childEnv: Record<string, string | undefined> = {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
        CLICOLOR: "1",
        CLICOLOR_FORCE: "1",
        PYTHONUNBUFFERED: "1",
        npm_config_color: "always",
        ...env,
      }

      try {
        const userShell = getDefaultShell()

        if (usePty) {
          const ptyEnv: Record<string, string> = { PATH: getDefaultPath() }
          for (const [k, v] of Object.entries(childEnv)) {
            if (v !== undefined) ptyEnv[k] = v
          }
          const ptyProcess = nodePty.spawn(
            userShell,
            ["--login", "-c", command],
            {
              name: "xterm-256color",
              cols: cols || 120,
              rows: rows || 30,
              cwd,
              env: ptyEnv,
            }
          )
          const dummyChild = spawn("true", [], { stdio: "ignore" })
          registerCommand({
            commandId,
            command,
            cwd,
            projectCwd,
            tabId,
            pid: ptyProcess.pid,
            process: dummyChild,
            ptyProcess,
            usePty: true,
            timestamp: new Date().toISOString(),
          })
          Effect.runFork(send({ type: "pid", commandId, pid: ptyProcess.pid }))
          Effect.runFork(
            attachPtyListeners(registry, send, commandId, ptyProcess)
          )
        } else {
          const child = spawn(userShell, ["--login", "-c", command], {
            cwd,
            env: childEnv as NodeJS.ProcessEnv,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          })
          if (child.pid) {
            registerCommand({
              commandId,
              command,
              cwd,
              projectCwd,
              tabId,
              pid: child.pid,
              process: child,
              timestamp: new Date().toISOString(),
            })
            Effect.runFork(send({ type: "pid", commandId, pid: child.pid }))
            Effect.runFork(
              attachPipeListeners(registry, send, commandId, child)
            )
          } else {
            Effect.runFork(
              send({ type: "error", commandId, error: "Failed to spawn process" })
            )
          }
        }
      } catch (e) {
        Effect.runFork(
          send({ type: "error", commandId, error: (e as Error).message })
        )
      }
    } else if (type === "stdin") {
      const { commandId, data } = msg as { commandId: string; data: string }
      const cmd = getRunningCommand(commandId)
      if (!cmd) return

      if (cmd.usePty && cmd.ptyProcess) {
        try {
          cmd.ptyProcess.write(data)
        } catch {
          /* exited */
        }
      } else {
        if (data === "\x03" && cmd.pid) {
          try {
            process.kill(-cmd.pid, "SIGINT")
          } catch {
            try {
              process.kill(cmd.pid, "SIGINT")
            } catch {
              /* exited */
            }
          }
        } else if (data === "\x1a" && cmd.pid) {
          try {
            process.kill(cmd.pid, "SIGTSTP")
          } catch {
            /* exited */
          }
        } else if (data === "\x04") {
          try {
            cmd.process.stdin?.end()
          } catch {
            /* closed */
          }
        } else if (cmd.process.stdin?.writable) {
          cmd.process.stdin.write(data)
        }
      }
    } else if (type === "attach") {
      const { commandId } = msg as { commandId: string }
      const cmd = getRunningCommand(commandId)
      if (!cmd) {
        Effect.runFork(
          send({
            type: "error",
            commandId,
            error: "Command not found or already finished",
          })
        )
        return
      }
      Effect.runFork(send({ type: "pid", commandId, pid: cmd.pid }))

      if (cmd.usePty && cmd.ptyRingBuffer) {
        const snap = cmd.ptyRingBuffer.snapshot()
        if (snap) {
          const replay = snap.slice(findSafeStart(snap))
          if (replay)
            Effect.runFork(send({ type: "stdout", commandId, data: replay }))
        }
      } else {
        const buffered =
          cmd.outputLines.join("\n") +
          (cmd.outputPartial ? "\n" + cmd.outputPartial : "")
        if (buffered) {
          Effect.runFork(send({ type: "stdout", commandId, data: buffered }))
        }
      }

      if (cmd.usePty && cmd.ptyProcess) {
        Effect.runFork(
          attachPtyListeners(registry, send, commandId, cmd.ptyProcess)
        )
      } else {
        Effect.runFork(
          attachPipeListeners(registry, send, commandId, cmd.process)
        )
      }
    } else if (type === "interrupt") {
      const { pid } = msg as { pid: number }
      if (!pid) return
      const descendants = getDescendantPids(pid)
      const allPids = [...descendants, pid]
      for (const p of allPids) {
        try {
          process.kill(p, "SIGTERM")
        } catch {
          /* ignore */
        }
      }
      setTimeout(() => {
        for (const p of allPids) {
          try {
            process.kill(p, 0)
            process.kill(p, "SIGKILL")
          } catch {
            /* exited */
          }
        }
      }, 1000)
    } else if (type === "resize") {
      const { commandId, cols, rows } = msg as {
        commandId: string
        cols: number
        rows: number
      }
      const cmd = getRunningCommand(commandId)
      if (cmd?.usePty && cmd.ptyProcess) {
        try {
          cmd.ptyProcess.resize(cols, rows)
        } catch {
          /* exited */
        }
      }
    } else if (type === "running") {
      const commands = getRunningCommands(projectCwd)
      if (commands.length === 0) {
        const size = getRegistrySize()
        const cwds = getAllProjectCwds()
        Effect.runFork(
          Effect.logWarning("[ws/terminal] running query: 0 commands").pipe(
            Effect.annotateLogs("projectCwd", projectCwd),
            Effect.annotateLogs("registryTotal", size),
            Effect.annotateLogs("cwds", cwds)
          )
        )
      }
      Effect.runFork(send({ type: "running", commands }))
    }
  })

// ─────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────

export const handleTerminal = (
  conn: WSConnection,
  projectCwd: string
): Effect.Effect<void, WSError | ValidationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!projectCwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "projectCwd", reason: "missing" })
      )
    }

    yield* Effect.logInfo("ws/terminal start").pipe(
      Effect.annotateLogs("projectCwd", projectCwd)
    )

    const registry = yield* makeCleanupRegistry()

    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // Main message loop
    yield* conn.messages.pipe(
      Stream.mapEffect((raw) =>
        dispatchMessage(
          raw as Record<string, unknown>,
          projectCwd,
          registry,
          conn.send
        )
      ),
      Stream.runDrain
    )
  }).pipe(
    Effect.withSpan("ws.handleTerminal", { attributes: { projectCwd } })
  )

// Bridge
export const runTerminalHandler = (ws: WebSocket, projectCwd: string): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "terminal")
      yield* handleTerminal(conn, projectCwd)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/terminal]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
