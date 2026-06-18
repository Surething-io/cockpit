/**
 * /api/git/current-branch — lightweight current-branch lookup.
 *
 * Runs only `git rev-parse --abbrev-ref HEAD`. Used by the project sidebar to
 * show each project's branch as a tooltip without paying for the heavier
 * /api/git/branches enumeration (local + remote + upstream).
 *
 * Returns `{ branch: string | null }` — null when the directory is not a git
 * repo or when HEAD is detached (git prints "HEAD"). The sidebar renders just
 * the project name in those cases.
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"

const execAsync = promisify(exec)

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd()

    const branch = yield* Effect.tryPromise({
      try: () =>
        execAsync("git rev-parse --abbrev-ref HEAD", { cwd }).then((r) =>
          r.stdout.trim()
        ),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))

    // Not a repo (rejected → null) or detached HEAD ("HEAD") → no branch.
    return ok({ branch: branch && branch !== "HEAD" ? branch : null })
  }).pipe(Effect.withSpan("api.git.currentBranch"))
)
