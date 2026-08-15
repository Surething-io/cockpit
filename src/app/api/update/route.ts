/**
 * /api/update — trigger a self-update.
 *
 * Hands the work to bin/updater.mjs and then exits. The server cannot reinstall
 * the package it is running from (see that file's header), so the sequence is:
 * spawn a detached updater outside the install directory, shut ourselves down,
 * and let it install and respawn us.
 *
 * Progress channel: we reserve a free loopback port here and hand it to the
 * updater, which serves its live state on it while we are gone. The number
 * comes back in this response because this is the last thing we can tell the
 * browser before exiting. It is best-effort — no port, or a failed bind, just
 * means the UI falls back to a local timer and the existing /api/health pid
 * poll. The authoritative record is still <cockpitHome>/update-state.json and
 * <cockpitHome>/logs/updater.log.
 */
import { Effect } from "effect"
import { join } from "path"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { PermissionError, ValidationError } from "@cockpit/effect-core"
import { COCKPIT_DIR } from "@cockpit/shared-utils"
import { pickFreePort, spawnHandoff } from "@/lib/processHandoff"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Long enough for this response to reach the client before we go away. */
const EXIT_DELAY = "300 millis"

export const POST = handler((req) =>
  Effect.gen(function* () {
    // Same unforgeable marker /api/shutdown uses: stamped by server.mjs after
    // the auth gate, forced to '0' on the share port.
    if (req.headers.get("x-cockpit-local") !== "1") {
      return yield* new PermissionError({ action: "update", resource: "server" })
    }

    // A dev server runs from a source tree; `npm i -g` would install the
    // published package and have nothing to do with it.
    if (process.env.COCKPIT_ENV === "dev") {
      return yield* new ValidationError({
        field: "mode",
        reason: "self-update is not available in dev mode",
      })
    }

    const installRoot = process.env.COCKPIT_ROOT
    if (!installRoot) {
      return yield* new ValidationError({
        field: "COCKPIT_ROOT",
        reason: "install directory is unknown",
      })
    }

    const fromVersion = process.env.COCKPIT_VERSION ?? "unknown"

    // Deliberately not in the failure channel: pickFreePort resolves undefined
    // instead of rejecting, because an update with no progress bar is fine and
    // an update refused because a port probe failed is not.
    const statusPort = yield* Effect.promise(() => pickFreePort())

    yield* Effect.try({
      try: () => spawnHandoff({ installRoot, fromVersion, restartOnly: false, statusPort }),
      catch: (e) =>
        new ValidationError({
          field: "handoff",
          reason: `could not stage the updater: ${String(e)}`,
        }),
    })

    // Give the response time to flush, then leave through the normal exit path
    // so PTY scrollback is persisted (server.mjs's 'exit' hook).
    yield* Effect.forkDaemon(
      Effect.sleep(EXIT_DELAY).pipe(
        Effect.andThen(
          Effect.sync(() => {
            console.log("[update] handing over to the updater; shutting down")
            process.exit(0)
          })
        )
      )
    )

    return ok({
      ok: true,
      from: fromVersion,
      statusPort: statusPort ?? null,
      logPath: join(COCKPIT_DIR, "logs", "updater.log"),
      statePath: join(COCKPIT_DIR, "update-state.json"),
    })
  })
)
