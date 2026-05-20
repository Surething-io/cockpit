/**
 * /api/git/branch-diff — P8+ migration
 *
 * Two-dot diff of current HEAD vs base branch (equivalent to a PR diff).
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

function unquotePath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1)
  return p
}

interface FileChange {
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  oldPath?: string
  additions: number
  deletions: number
}

const runGit = (
  cmd: string,
  cwd: string
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () =>
      execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }).then(
        (r) => r.stdout
      ),
    catch: (cause) =>
      new AppError({ message: `git command failed: ${cmd}`, cause }),
  })

const runGitOrEmpty = (cmd: string, cwd: string): Effect.Effect<string> =>
  runGit(cmd, cwd).pipe(Effect.orElseSucceed(() => ""))

const getBranchChangedFiles = (cwd: string, base: string) =>
  Effect.gen(function* () {
    const [nameStatus, numstat] = yield* Effect.all(
      [
        runGit(
          `git -c core.quotePath=false diff ${base} HEAD --name-status`,
          cwd
        ),
        runGit(
          `git -c core.quotePath=false diff ${base} HEAD --numstat`,
          cwd
        ),
      ],
      { concurrency: "unbounded" }
    )

    const statsMap = new Map<
      string,
      { additions: number; deletions: number }
    >()
    numstat
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        const parts = line.split("\t")
        if (parts.length >= 3) {
          const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10)
          const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10)
          const filename = unquotePath(parts.slice(2).join("\t"))
          statsMap.set(filename, { additions, deletions })
        }
      })

    const files: FileChange[] = []
    nameStatus
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        const parts = line.split("\t")
        if (parts.length < 2) return

        const statusCode = parts[0]
        let status: FileChange["status"]
        let path: string
        let oldPath: string | undefined

        if (statusCode.startsWith("R")) {
          status = "renamed"
          oldPath = unquotePath(parts[1])
          path = unquotePath(parts[2])
        } else {
          path = unquotePath(parts[1])
          switch (statusCode) {
            case "A":
              status = "added"
              break
            case "D":
              status = "deleted"
              break
            case "M":
            default:
              status = "modified"
              break
          }
        }

        const stats = statsMap.get(path) ||
          statsMap.get(oldPath || "") || { additions: 0, deletions: 0 }
        files.push({
          path,
          status,
          oldPath,
          additions: stats.additions,
          deletions: stats.deletions,
        })
      })

    return ok({ files })
  })

const getBranchFileDiff = (cwd: string, base: string, file: string) =>
  Effect.gen(function* () {
    const oldContent = yield* runGitOrEmpty(`git show ${base}:"${file}"`, cwd)
    const newContent = yield* runGitOrEmpty(`git show HEAD:"${file}"`, cwd)

    return ok({
      oldContent,
      newContent,
      filePath: file,
      isNew: oldContent === "" && newContent !== "",
      isDeleted: oldContent !== "" && newContent === "",
    })
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const base = sp.get("base")
    const file = sp.get("file")

    if (!base) {
      return yield* Effect.fail(
        new ValidationError({ field: "base", reason: "missing" })
      )
    }

    if (file) return yield* getBranchFileDiff(cwd, base, file)
    return yield* getBranchChangedFiles(cwd, base)
  }).pipe(Effect.withSpan("api.git.branch-diff"))
)
