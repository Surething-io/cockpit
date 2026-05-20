/**
 * /api/git/commit-diff
 *
 * Fetch the diff for a commit:
 * - without `file`: returns the list of changed files
 * - with `file`:    returns oldContent / newContent for that single file
 *
 * Merge commits and regular commits use different diff commands.
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
  cwd: string,
  maxBuffer = 10 * 1024 * 1024
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () =>
      execAsync(cmd, { cwd, maxBuffer }).then((r) => r.stdout),
    catch: (cause) =>
      new AppError({ message: `git command failed: ${cmd}`, cause }),
  })

const runGitOrEmpty = (
  cmd: string,
  cwd: string
): Effect.Effect<string> =>
  runGit(cmd, cwd).pipe(Effect.orElseSucceed(() => ""))

const getChangedFiles = (cwd: string, hash: string) =>
  Effect.gen(function* () {
    const parentInfo = yield* runGit(
      `git rev-list --parents -n 1 ${hash}`,
      cwd
    )
    const parents = parentInfo.trim().split(" ").slice(1)
    const isMergeCommit = parents.length > 1

    const [nameStatusCmd, numstatCmd] = isMergeCommit
      ? [
          `git -c core.quotePath=false diff ${hash}^1 ${hash} --name-status`,
          `git -c core.quotePath=false diff ${hash}^1 ${hash} --numstat`,
        ]
      : [
          `git -c core.quotePath=false show ${hash} --name-status --format=""`,
          `git -c core.quotePath=false show ${hash} --numstat --format=""`,
        ]

    const [nameStatus, numstat] = yield* Effect.all(
      [runGit(nameStatusCmd, cwd), runGit(numstatCmd, cwd)],
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
          let filename = parts.slice(2).join("\t")
          filename = unquotePath(filename)
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

const getFileDiff = (cwd: string, hash: string, file: string) =>
  Effect.gen(function* () {
    const parentHash = (yield* runGitOrEmpty(
      `git rev-parse ${hash}^1`,
      cwd
    )).trim()

    const oldContent = parentHash
      ? yield* runGitOrEmpty(`git show ${parentHash}:${file}`, cwd)
      : ""

    const newContent = yield* runGitOrEmpty(`git show ${hash}:${file}`, cwd)

    const isNew = oldContent === "" && newContent !== ""
    const isDeleted = oldContent !== "" && newContent === ""

    return ok({
      oldContent,
      newContent,
      filePath: file,
      isNew,
      isDeleted,
    })
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const hash = sp.get("hash")
    const file = sp.get("file")

    if (!hash) {
      return yield* Effect.fail(
        new ValidationError({ field: "hash", reason: "missing" })
      )
    }

    if (file) return yield* getFileDiff(cwd, hash, file)
    return yield* getChangedFiles(cwd, hash)
  }).pipe(Effect.withSpan("api.git.commit-diff"))
)
