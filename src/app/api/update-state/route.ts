/**
 * /api/update-state — the last recorded outcome of a self-update.
 *
 * bin/updater.mjs writes <cockpitHome>/update-state.json as it goes, and serves
 * the same object live on a loopback port while the server is down (see
 * /api/update). This endpoint is the two things that channel cannot cover:
 *
 *  1. BEFORE an update — the previous run's `installMs`, which is the only
 *     honest answer the UI has to "how long will this take".
 *  2. AFTER a reload — a tab that was reloaded mid-update, or opened after a
 *     failed one, has no in-memory state; this is where it recovers the
 *     outcome so a failure is not silently lost with the old page.
 *
 * A missing file is a normal empty state, not an error: it just means this
 * install has never updated itself.
 */
import { Effect } from "effect"
import { readFile } from "fs/promises"
import { join } from "path"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { COCKPIT_DIR } from "@cockpit/shared-utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_PATH = join(COCKPIT_DIR, "update-state.json")

export const GET = handler(() =>
  Effect.gen(function* () {
    // Read and parse inside the same tryPromise: a JSON.parse in a later
    // Effect.map would throw as a DEFECT, which orElseSucceed does not catch,
    // and a half-written file (the updater writes it non-atomically) would 500.
    const state = yield* Effect.tryPromise(async () => {
      const raw = await readFile(STATE_PATH, "utf-8")
      return JSON.parse(raw) as Record<string, unknown>
    }).pipe(
      // Absent, unreadable or mid-write all mean the same thing here: nothing
      // to show yet.
      Effect.orElseSucceed(() => null)
    )

    return ok({ state, logPath: join(COCKPIT_DIR, "logs", "updater.log") })
  })
)
