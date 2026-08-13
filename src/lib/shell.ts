/**
 * Server-only shell helpers for the cockpit.bash channel.
 *
 * These live here (not in @cockpit/shared-utils/platform.ts) on purpose:
 * platform.ts is isomorphic (the browser bundle imports modKey from it), so it
 * must not import node `fs`/`child_process`. This module is only imported from
 * server code (src/lib/effect/*), so it can.
 */
import { existsSync } from "fs"
import { execSync, spawn, type ChildProcess } from "child_process"
import { isWindows, getDefaultShell } from "@cockpit/shared-utils"

let bashCache: string | null | undefined
let gitBashCache: string | null | undefined
let pwshCache: string | undefined

/**
 * Git Bash (MSYS2) only — deliberately no WSL fallback.
 *
 * Git Bash runs *in* the Windows process/filesystem namespace, so a `C:\…` cwd
 * and the paths Cockpit hands the agent stay valid. WSL's `bash.exe` does not:
 * it would put the shell in a Linux namespace where the same directory is
 * `/mnt/c/…`, giving one session two path vocabularies. Use resolveBashShell()
 * when a WSL bash is an acceptable last resort; use this when it is not.
 */
export function resolveGitBash(): string | null {
  if (!isWindows) return null
  if (gitBashCache !== undefined) return gitBashCache

  const envShell = process.env.SHELL
  const candidates = [
    ...(envShell && /bash(\.exe)?$/i.test(envShell) ? [envShell] : []),
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ...(process.env.ProgramFiles ? [`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`] : []),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return (gitBashCache = c)
  }
  // Don't cache a null result: the user may install Git Bash later and we
  // shouldn't keep reporting "not found" until the process restarts.
  return null
}

/**
 * PowerShell for Windows: PowerShell 7+ (`pwsh.exe`) when installed, otherwise
 * the in-box Windows PowerShell 5.1, which is always present. Never returns
 * `cmd.exe` — callers use this as an interactive shell and cmd lacks the
 * argument forms they rely on.
 */
export function resolveWindowsPowerShell(): string {
  if (pwshCache !== undefined) return pwshCache
  try {
    const found = execSync("where pwsh", { encoding: "utf-8", timeout: 3000 })
      .trim()
      .split(/\r?\n/)[0]
    if (found && existsSync(found)) return (pwshCache = found)
  } catch {
    /* PowerShell 7 not installed — fall through to the in-box one */
  }
  return (pwshCache = "powershell.exe")
}

/**
 * Resolve the bash executable used to run `cockpit.bash` commands with
 * `["--login", "-c", cmd]`.
 *  - posix: the user's login shell (bash/zsh both accept `--login -c`).
 *  - Windows: Git Bash (MSYS2, handles `C:\` cwd + paths) preferred, then a
 *    `bash` on PATH (may be WSL). Returns null when none is installed — the
 *    caller surfaces a clear "install Git Bash/WSL" error instead of spawning
 *    `cmd --login -c` (which would misbehave).
 *
 * A WSL bash is tolerated here because this channel runs one-shot commands
 * whose output is piped straight back, so the namespace mismatch is contained.
 */
export function resolveBashShell(): string | null {
  if (!isWindows) return getDefaultShell()
  if (bashCache !== undefined) return bashCache

  const gitBash = resolveGitBash()
  if (gitBash) return (bashCache = gitBash)

  // Last resort: a `bash` on PATH (often WSL's System32\bash.exe).
  try {
    const found = execSync("where bash", { encoding: "utf-8", timeout: 3000 })
      .trim()
      .split(/\r?\n/)[0]
    if (found && existsSync(found)) return (bashCache = found)
  } catch {
    /* not on PATH */
  }
  // Don't cache a null result: the user may install Git Bash/WSL later and we
  // shouldn't keep reporting "not found" until the process restarts.
  return null
}

/**
 * Kill a spawned command's whole process tree, cross-platform.
 *  - Windows: `taskkill /T /F` (posix process-group signals don't exist).
 *  - posix: SIGTERM the process group (negative pid), SIGKILL survivors.
 *
 * Takes the ChildProcess (not a bare pid) so the delayed SIGKILL can be
 * cancelled the instant the child exits, and only escalates while the child is
 * still running — otherwise a `-pid` SIGKILL 1s later could hit an unrelated
 * process group that the OS assigned the recycled pid to (pid-reuse TOCTOU).
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (isWindows) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      /* already gone */
    }
    return
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        /* already exited */
      }
    }
  }
  signal("SIGTERM")
  const timer = setTimeout(() => {
    // Only escalate if THIS child is still running. Once it has exited, exitCode
    // is set — signalling the (possibly recycled) pid then would be a misfire.
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL")
  }, 1000)
  if (typeof timer.unref === "function") timer.unref()
  child.once("exit", () => clearTimeout(timer))
}
