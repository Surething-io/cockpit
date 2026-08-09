/**
 * handleTerminal — Effect-based WebSocket handler (the most complex handler).
 *
 *   - Scope.addFinalizer owns every listener cleanup; everything is released
 *     when the fiber is interrupted.
 *   - Stream.mapEffect replaces the imperative ws.on('message') dispatcher.
 *   - Heartbeat is driven by Schedule.spaced and cancels automatically.
 *   - Spawn / attach / signal / resize semantics match the original handler.
 */
import { spawn, execFileSync, execSync, type ChildProcess } from "child_process"
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
  writeStdinToCommand,
} from "@cockpit/feature-console/server"
import {
  isWindows,
  getDefaultShell,
  getDefaultPath,
} from "@cockpit/shared-utils"

const HEARTBEAT = Schedule.spaced("30 seconds")
const OPEN_PREFERRED_SHELL_COMMAND = "__cockpit_open_preferred_shell__"

type PtySpawnTarget = {
  file: string
  args: string[]
  cwd: string
  name: string
}

function commandPath(command: string): string | null {
  try {
    const found = execSync(`command -v ${command}`, {
      encoding: "utf-8",
      timeout: 3000,
    })
      .trim()
      .split(/\r?\n/)[0]
    return found || null
  } catch {
    return null
  }
}

function loginShellArgs(shell: string): string[] {
  if (shell === "bash") return ["--login"]
  return ["-l"]
}

function resolvePreferredPtyShell(cwd: string): PtySpawnTarget {
  if (isWindows) {
    try {
      const wslShell = execFileSync(
        "wsl.exe",
        [
          "sh",
          "-lc",
          "command -v zsh >/dev/null 2>&1 && printf zsh || { command -v bash >/dev/null 2>&1 && printf bash; }",
        ],
        { encoding: "utf-8", timeout: 3000 }
      ).trim()
      if (wslShell === "zsh" || wslShell === "bash") {
        return {
          file: "wsl.exe",
          args: ["--cd", cwd, "--exec", wslShell, ...loginShellArgs(wslShell)],
          cwd: process.cwd(),
          name: wslShell,
        }
      }
    } catch {
      /* WSL unavailable or no supported shell installed. */
    }
  } else {
    for (const shell of ["zsh", "bash", "sh"]) {
      const file = commandPath(shell)
      if (file) return { file, args: loginShellArgs(shell), cwd, name: shell }
    }
  }

  const fallback = getDefaultShell()
  const fallbackName = fallback.split(/[\\/]/).pop() || fallback
  return {
    file: fallback,
    args: isWindows ? [] : loginShellArgs(fallbackName),
    cwd,
    name: fallbackName,
  }
}

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
      const { commandId, command, cwd, tabId, env, usePty, cols, rows, sourceId } =
        msg as {
          commandId: string
          command: string
          cwd: string
          tabId: string
          env?: Record<string, string>
          usePty?: boolean
          cols?: number
          rows?: number
          sourceId?: string
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
        // UTF-8 locale so the pty renders multi-byte text (CJK, emoji) correctly.
        // ptyEnv is rebuilt from scratch (not inherited from process.env), and a
        // macOS `--login` shell does NOT restore LANG (Terminal.app/iTerm inject it,
        // not the rc files) — so without this, vim/less open UTF-8 files in the
        // C/POSIX locale and mojibake every non-ASCII char. Pass the real locale
        // through when present, else fall back to a UTF-8 default; LC_ALL/LC_CTYPE
        // stay undefined (and are skipped below) unless the server actually has them.
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL,
        LC_CTYPE: process.env.LC_CTYPE,
        FORCE_COLOR: "1",
        CLICOLOR: "1",
        CLICOLOR_FORCE: "1",
        PYTHONUNBUFFERED: "1",
        npm_config_color: "always",
        // Propagate the cockpit data dir + server port so CLI bridges
        // (cock-terminal/browser/connection) run inside the PTY resolve the
        // SAME data dir and hit THIS server, not a sibling dev/prod instance.
        // (childEnv is rebuilt from scratch, so these must be explicit.)
        COCKPIT_HOME: process.env.COCKPIT_HOME,
        COCKPIT_PORT: process.env.COCKPIT_PORT,
        ...env,
      }

      try {
        const userShell = getDefaultShell()

        if (usePty) {
          const ptyEnv: Record<string, string> = { PATH: getDefaultPath() }
          for (const [k, v] of Object.entries(childEnv)) {
            if (v !== undefined) ptyEnv[k] = v
          }
          const ptyTarget =
            command === OPEN_PREFERRED_SHELL_COMMAND
              ? resolvePreferredPtyShell(cwd)
              : { file: userShell, args: ["--login", "-c", command], cwd, name: command }
          const ptyProcess = nodePty.spawn(
            ptyTarget.file,
            ptyTarget.args,
            {
              name: "xterm-256color",
              cols: cols || 120,
              rows: rows || 30,
              cwd: ptyTarget.cwd,
              env: ptyEnv,
            }
          )
          const dummyChild = spawn("true", [], { stdio: "ignore" })
          registerCommand({
            commandId,
            command: ptyTarget.name,
            cwd,
            projectCwd,
            tabId,
            pid: ptyProcess.pid,
            process: dummyChild,
            ptyProcess,
            usePty: true,
            timestamp: new Date().toISOString(),
            sourceId,
          })
          Effect.runFork(send({ type: "pid", commandId, pid: ptyProcess.pid, command: ptyTarget.name }))
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
              sourceId,
            })
            Effect.runFork(send({ type: "pid", commandId, pid: child.pid, command }))
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
      // Pipe-mode control-char → signal decoding lives in writeStdinToCommand
      // so the HTTP /api/terminal/stdin path can share the same semantics.
      writeStdinToCommand(cmd, data)
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
      Effect.runFork(send({ type: "pid", commandId, pid: cmd.pid, command: cmd.command }))

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
