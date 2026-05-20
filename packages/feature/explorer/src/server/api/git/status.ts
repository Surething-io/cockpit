/**
 * /api/git/status — list staged/unstaged changes in a working tree.
 *
 * Thin route shell — see EFFECT.md §3. Business logic lives in GitService.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { GitService, GitServiceLive } from "../../effect/git"

// Re-export for src/app/api/git/status/route.ts.
export type { GitFileStatus, GitStatusResponse } from "../../effect/git"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const cwd = url.searchParams.get("cwd") || process.cwd()
    const service = yield* GitService
    const result = yield* service.status(cwd)
    return ok(result)
  }).pipe(Effect.provide(GitServiceLive))
)
