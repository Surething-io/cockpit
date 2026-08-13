/**
 * Hand control to an out-of-process helper that will outlive this server.
 *
 * Shared by /api/update and /api/restart. Both need the same thing: a process
 * that is NOT this one to wait for us to exit and then launch the replacement.
 * For an update that is a hard requirement (a process cannot reinstall the
 * package it runs from). For a restart the reason is different but just as
 * important — it is how the server's ENVIRONMENT survives.
 *
 * COCKPIT_TOKEN, PORT and COCKPIT_HOST are inherited down this chain:
 *
 *     server (env E) -> updater (E) -> replacement server (E + overrides)
 *
 * A CLI-driven stop+start cannot do that: it rebuilds the environment from
 * whatever shell the user is in, so a token-protected instance silently comes
 * back open. Restarting through the running server is what makes
 * `cockpit restart` safe without asking the user to re-supply anything.
 *
 * Plain module (not Effect): outside EFFECT.md's enforced globs — src/app/api/**
 * and src/lib/effect/** — same as src/lib/auth.ts.
 */
import { copyFileSync, mkdirSync } from "fs"
import { join } from "path"
import { spawn } from "child_process"
import { COCKPIT_DIR, sanitizedSpawnEnv } from "@cockpit/shared-utils"

export interface HandoffOptions {
  /** Install directory (COCKPIT_ROOT) — where bin/updater.mjs lives. */
  readonly installRoot: string
  /** Version we are leaving, used for rollback on a failed install. */
  readonly fromVersion: string
  /** Skip the npm install step and only relaunch. */
  readonly restartOnly: boolean
}

/**
 * Stage the helper outside the install directory and launch it detached.
 * Returns its pid. Throws if the script cannot be staged.
 */
export function spawnHandoff(opts: HandoffOptions): number | undefined {
  const { installRoot, fromVersion, restartOnly } = opts

  // Copy out of the install directory before running: `npm i -g` replaces that
  // directory wholesale and would delete the script mid-run. Harmless for a
  // restart, but keeping one path avoids two subtly different behaviours.
  const updaterDir = join(COCKPIT_DIR, "updater")
  const updaterPath = join(updaterDir, "updater.mjs")
  mkdirSync(updaterDir, { recursive: true })
  copyFileSync(join(installRoot, "bin", "updater.mjs"), updaterPath)

  const args = [
    updaterPath,
    "--pid", String(process.pid),
    "--root", installRoot,
    "--home", COCKPIT_DIR,
    "--from", fromVersion,
  ]
  if (restartOnly) args.push("--restart-only")

  const child = spawn(process.execPath, args, {
    // Never the install dir: on Windows a process's cwd blocks that directory
    // from being replaced.
    cwd: COCKPIT_DIR,
    // sanitizedSpawnEnv strips only what Next injects into our own process
    // (NODE_ENV, TURBOPACK, ...); everything else — crucially COCKPIT_TOKEN —
    // rides along.
    env: sanitizedSpawnEnv(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  })
  child.unref()

  // Exempt it from server.mjs's exit-time child cleanup. That hook runs
  // `pkill -P <server pid>`, and `detached: true` does NOT sever the
  // parent/child link — it only moves the child to a new session and process
  // group. Without this the server kills the process that was supposed to
  // bring it back, leaving the machine with no server at all.
  ;(globalThis as { __cockpitHandedOffPid?: number }).__cockpitHandedOffPid =
    child.pid

  return child.pid
}
