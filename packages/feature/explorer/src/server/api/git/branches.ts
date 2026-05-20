/**
 * /api/git/branches — P8+ migration
 *
 * List current / upstream / local / remote branches.
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

const runGit = (
  cmd: string,
  cwd: string
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () => execAsync(cmd, { cwd }).then((r) => r.stdout),
    catch: (cause) =>
      new AppError({ message: `git command failed: ${cmd}`, cause }),
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd()

    const [currentBranch, localBranches, remoteBranches] = yield* Effect.all(
      [
        runGit("git rev-parse --abbrev-ref HEAD", cwd),
        runGit('git branch --format="%(refname:short)"', cwd),
        runGit('git branch -r --format="%(refname:short)"', cwd),
      ],
      { concurrency: "unbounded" }
    )

    // Upstream may not exist → fall back to origin/main
    const upstream = yield* runGit(
      "git rev-parse --abbrev-ref @{upstream}",
      cwd
    ).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => "origin/main")
    )

    const local = localBranches
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)

    const remote = remoteBranches
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .filter((b) => !b.includes("HEAD"))

    return ok({ current: currentBranch.trim(), upstream, local, remote })
  }).pipe(Effect.withSpan("api.git.branches"))
)
