/**
 * /api/shutdown — graceful, cross-platform stop.
 *
 * Signals are not a portable stop mechanism. Windows has no SIGTERM, so
 * `process.kill(pid)` there is a hard TerminateProcess: server.mjs's 'exit'
 * hook never runs and live PTY scrollback is lost instead of being flushed to
 * disk. An HTTP request reaches the process identically on every platform and
 * lets it leave through its own normal exit path, so `cockpit stop` has one
 * code path everywhere and only falls back to signals when this does not
 * answer.
 *
 * Local-only. `x-cockpit-local` is stamped by server.mjs *after* the auth gate
 * (loopback peer + no forwarding header) and is not settable by a client; the
 * share server forces it to '0'. Same marker the review API already trusts.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { PermissionError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Grace period so the response reaches the client before the process goes. */
const EXIT_DELAY = "150 millis"

export const POST = handler((req) =>
  Effect.gen(function* () {
    if (req.headers.get("x-cockpit-local") !== "1") {
      return yield* new PermissionError({
        action: "shutdown",
        resource: "server",
      })
    }

    // forkDaemon, not the request fiber: the response has to be returned before
    // the exit fires. process.exit(0) then runs server.mjs's 'exit' hook —
    // flushRunningSync() to persist terminal scrollback, then killChildren().
    yield* Effect.forkDaemon(
      Effect.sleep(EXIT_DELAY).pipe(
        Effect.andThen(
          Effect.sync(() => {
            console.log("[shutdown] requested via /api/shutdown")
            process.exit(0)
          })
        )
      )
    )

    return ok({ ok: true, pid: process.pid })
  })
)
