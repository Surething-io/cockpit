/**
 * GitService — Effect wrapper around `git status` and related porcelain commands.
 *
 * Contract (EFFECT.md):
 * - §2: child_process.exec failures map to AppError + cause; non-git-repo → ValidationError.
 * - §4: Service Tag + Live in this single file.
 * - §11: business functions carry explicit Effect<A, E> return types.
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Context, Effect, Layer } from "effect"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

// ─────────────────────────────────────────────────────────
// Data model — wire-compatible GitStatusResponse.
// ─────────────────────────────────────────────────────────

export interface GitFileStatus {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
  oldPath?: string
  additions?: number
  deletions?: number
}

export interface GitStatusResponse {
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  cwd: string
}

// ─────────────────────────────────────────────────────────
// Pure helpers (EFFECT.md §0 exception: pure computation stays non-Effect).
// ─────────────────────────────────────────────────────────

function getStatusFromCode(code: string): GitFileStatus["status"] {
  switch (code) {
    case "A":
      return "added"
    case "M":
      return "modified"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    case "?":
      return "untracked"
    default:
      return "modified"
  }
}

function parseGitStatus(output: string): {
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
} {
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []
  const lines = output.split("\n").filter((line) => line.trim())

  for (const line of lines) {
    if (line.length < 3) continue
    const indexStatus = line[0]
    const workTreeStatus = line[1]
    let filePath = line.slice(3)

    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1)
    }

    let oldPath: string | undefined
    if (filePath.includes(" -> ")) {
      const parts = filePath.split(" -> ")
      oldPath = parts[0]
      filePath = parts[1]
    }

    if (indexStatus !== " " && indexStatus !== "?") {
      staged.push({
        path: filePath,
        status: getStatusFromCode(indexStatus),
        oldPath,
      })
    }

    if (workTreeStatus !== " ") {
      if (filePath.endsWith("/")) continue
      if (workTreeStatus === "?") {
        unstaged.push({ path: filePath, status: "untracked" })
      } else {
        unstaged.push({ path: filePath, status: getStatusFromCode(workTreeStatus) })
      }
    }
  }

  return { staged, unstaged }
}

function parseNumstat(
  output: string
): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  const lines = output.split("\n").filter((line) => line.trim())
  for (const line of lines) {
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const [addRaw, delRaw, ...rest] = parts
    if (addRaw === "-" || delRaw === "-") continue
    let path = rest.join("\t")
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1)
    }
    const renameMatch = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
    if (renameMatch) {
      path = `${renameMatch[1]}${renameMatch[3]}${renameMatch[4]}`.replace(
        /\/+/g,
        "/"
      )
    }
    map.set(path, {
      additions: Number.parseInt(addRaw, 10) || 0,
      deletions: Number.parseInt(delRaw, 10) || 0,
    })
  }
  return map
}

// ─────────────────────────────────────────────────────────
// Service Tag (§4)
// ─────────────────────────────────────────────────────────

export interface GitService {
  readonly status: (
    cwd: string
  ) => Effect.Effect<GitStatusResponse, AppError | ValidationError>
}

export const GitService = Context.GenericTag<GitService>("@cockpit/GitService")

// ─────────────────────────────────────────────────────────
// Adapter — wrap exec, map failures to AppError (EFFECT.md §9).
// ─────────────────────────────────────────────────────────

const runGit = (
  cmd: string,
  cwd: string
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () => execAsync(cmd, { cwd }).then((r) => r.stdout),
    catch: (cause) =>
      new AppError({ message: `git command failed: ${cmd}`, cause }),
  })

const checkIsRepo = (cwd: string): Effect.Effect<void, ValidationError> =>
  runGit("git rev-parse --git-dir", cwd).pipe(
    Effect.mapError(
      () =>
        new ValidationError({
          field: "cwd",
          reason: "not a git repository",
        })
    ),
    Effect.asVoid
  )

// ─────────────────────────────────────────────────────────
// Live implementation
// ─────────────────────────────────────────────────────────

export const GitServiceLive = Layer.succeed(
  GitService,
  GitService.of({
    status: (cwd) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("git.status start").pipe(
          Effect.annotateLogs("cwd", cwd)
        )

        // 1. Verify this is a git repository.
        yield* checkIsRepo(cwd)

        // 2. Read porcelain status output.
        const stdout = yield* runGit(
          "git -c core.quotePath=false status --porcelain=v1 -u",
          cwd
        )
        const { staged, unstaged } = parseGitStatus(stdout)

        // 3. Fetch both numstats concurrently (EFFECT.md §8: Effect.all over Promise.all).
        //    On failure (e.g. initial-commit edge case), fall back to an empty Map so
        //    the main response is not affected.
        const [stagedNumstat, unstagedNumstat] = yield* Effect.all(
          [
            runGit("git -c core.quotePath=false diff --cached --numstat", cwd).pipe(
              Effect.map(parseNumstat),
              Effect.orElseSucceed(
                () => new Map<string, { additions: number; deletions: number }>()
              )
            ),
            runGit("git -c core.quotePath=false diff --numstat", cwd).pipe(
              Effect.map(parseNumstat),
              Effect.orElseSucceed(
                () => new Map<string, { additions: number; deletions: number }>()
              )
            ),
          ],
          { concurrency: "unbounded" }
        ).pipe(Effect.withSpan("git.numstat"))

        for (const file of staged) {
          const stat = stagedNumstat.get(file.path)
          if (stat) {
            file.additions = stat.additions
            file.deletions = stat.deletions
          }
        }
        for (const file of unstaged) {
          const stat = unstagedNumstat.get(file.path)
          if (stat) {
            file.additions = stat.additions
            file.deletions = stat.deletions
          }
        }

        yield* Effect.logInfo("git.status done").pipe(
          Effect.annotateLogs("staged.count", staged.length),
          Effect.annotateLogs("unstaged.count", unstaged.length)
        )

        return { staged, unstaged, cwd } satisfies GitStatusResponse
      }).pipe(Effect.withSpan("git.status", { attributes: { cwd } })),
  })
)
