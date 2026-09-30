/**
 * /api/terminal/running — every live terminal bubble across all projects.
 *
 * GET  → [{ commandId, shortId, title?, command, cwd, projectCwd, tabId, pid, timestamp, usePty? }]
 * POST { commandId } → interrupt it (same semantics as the bubble's stop button)
 *
 * Feeds the sidebar's running-terminals board. Clients refetch on the
 * `running-terminals-changed` global-state ping (see consoleBroadcast.ts).
 */
import { Effect } from "effect"
import { toShortId } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import {
  adoptPtyHostSessions,
  interruptCommand,
  listAllRunning,
} from "../../terminal/RunningCommandRegistry"
import { readBubbleTitles } from "./bubble-order"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler(() =>
  Effect.gen(function* () {
    // Right after a restart the pty-host sessions may not be adopted yet.
    yield* Effect.promise(() => adoptPtyHostSessions().catch(() => undefined))
    const running = listAllRunning()

    // One bubble-order read per (project, tab) pair, not per terminal.
    const SEP = String.fromCharCode(0x1f)
    const pairs = [...new Set(running.map((r) => `${r.projectCwd}${SEP}${r.tabId}`))]
    const titles = new Map<string, Record<string, string>>()
    yield* Effect.all(
      pairs.map((pair) => {
        const [cwd, tabId] = pair.split(SEP)
        return Effect.tryPromise({
          try: () => readBubbleTitles(cwd, tabId),
          catch: (cause) => new FSError({ path: cwd, op: "read", cause }),
        }).pipe(Effect.tap((t) => Effect.sync(() => titles.set(pair, t))))
      }),
      { concurrency: "unbounded", discard: true }
    )

    return ok(
      running.map((r) => {
        const title = titles.get(`${r.projectCwd}${SEP}${r.tabId}`)?.[r.commandId]
        return {
          ...r,
          shortId: toShortId(r.tabId + r.commandId),
          ...(title ? { title } : {}),
        }
      })
    )
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { commandId?: string }
    if (!body.commandId) {
      return yield* Effect.fail(
        new ValidationError({ field: "commandId", reason: "missing" })
      )
    }
    return ok({ interrupted: interruptCommand(body.commandId) })
  })
)
