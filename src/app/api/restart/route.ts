/**
 * /api/restart — restart the server in place, preserving its environment.
 *
 * Exists so `cockpit restart` does not have to rebuild the launch environment
 * from the user's shell. The running server knows its own COCKPIT_TOKEN, PORT
 * and COCKPIT_HOST; handing off through a detached helper carries all of them
 * to the replacement (see src/lib/processHandoff.ts). Restarting from the CLI
 * instead would silently drop a token gate — turning a tunnel-exposed instance
 * into an open one — and require the user to re-supply every flag.
 */
import { Effect } from "effect"
import { join } from "path"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { PermissionError, ValidationError } from "@cockpit/effect-core"
import { COCKPIT_DIR } from "@cockpit/shared-utils"
import { spawnHandoff } from "@/lib/processHandoff"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Long enough for this response to reach the client before we go away. */
const EXIT_DELAY = "300 millis"

export const POST = handler((req) =>
  Effect.gen(function* () {
    if (req.headers.get("x-cockpit-local") !== "1") {
      return yield* new PermissionError({ action: "restart", resource: "server" })
    }

    // The helper relaunches with `node server.mjs`, which is wrong for dev —
    // that needs `--import tsx`. Ctrl-C and rerun instead.
    if (process.env.COCKPIT_ENV === "dev") {
      return yield* new ValidationError({
        field: "mode",
        reason: "restart is not available in dev mode",
      })
    }

    const installRoot = process.env.COCKPIT_ROOT
    if (!installRoot) {
      return yield* new ValidationError({
        field: "COCKPIT_ROOT",
        reason: "install directory is unknown",
      })
    }

    yield* Effect.try({
      try: () =>
        spawnHandoff({
          installRoot,
          fromVersion: process.env.COCKPIT_VERSION ?? "unknown",
          restartOnly: true,
        }),
      catch: (e) =>
        new ValidationError({
          field: "handoff",
          reason: `could not stage the restart helper: ${String(e)}`,
        }),
    })

    yield* Effect.forkDaemon(
      Effect.sleep(EXIT_DELAY).pipe(
        Effect.andThen(
          Effect.sync(() => {
            console.log("[restart] handing over; shutting down")
            process.exit(0)
          })
        )
      )
    )

    return ok({
      ok: true,
      pid: process.pid,
      logPath: join(COCKPIT_DIR, "logs", "updater.log"),
    })
  })
)
