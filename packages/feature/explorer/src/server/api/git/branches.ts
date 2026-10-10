/**
 * /api/git/branches — P8+ migration
 *
 * List current / upstream / local / remote branches.
 */
import { execFile } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError } from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)

const runGit = (
  args: string[],
  cwd: string
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () => execFileAsync("git", args, { cwd }).then((r) => r.stdout),
    catch: (cause) =>
      new AppError({ message: `git command failed: git ${args.join(" ")}`, cause }),
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd()

    const [currentBranch, localBranches, remoteBranches] = yield* Effect.all(
      [
        runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
        runGit(["branch", "--format=%(refname:short)"], cwd),
        runGit(["branch", "-r", "--format=%(refname:short)"], cwd),
      ],
      { concurrency: "unbounded" }
    )

    // Upstream may not exist → fall back to origin/main
    const upstream = yield* runGit(
      ["rev-parse", "--abbrev-ref", "@{upstream}"],
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
