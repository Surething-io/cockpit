/**
 * /api/git/branch-diff — diff of this branch against a base branch.
 *
 * Two modes, selected by `?mode=`:
 *
 *   - `head`     — base…HEAD, i.e. committed work only. This is the GitHub
 *                  "Files changed" diff.
 *   - `worktree` — base…working tree (default). Committed work PLUS staged,
 *                  unstaged and untracked files.
 *
 * Why `worktree` is the default: the two other git views in the file browser
 * are base→HEAD (this route) and HEAD→working tree (the status tab), so
 * "everything this branch changed" — the question an agent-driven session
 * actually asks, where most edits are not committed yet — was answerable by
 * neither. A branch with zero commits rendered a bare "no changed files" while
 * a pile of fresh edits sat in the working tree.
 *
 * Both modes anchor the old side at the MERGE BASE, never at the base branch
 * tip. Two-dot `git diff <base> HEAD` (what this route used to run) reports
 * commits made on the base branch *since you branched* as if your branch had
 * reverted them. `merge-base` is also the only spelling that works for the
 * worktree mode: three-dot `<base>...` is rejected when one side is the
 * working tree.
 *
 * Untracked files are folded in by hand (`git status`), because `git diff`
 * never reports them — without this the default mode would silently drop every
 * brand-new file, which in a fresh feature branch is most of the diff.
 *
 * git is invoked through execFile with an argv array — no shell — so branch
 * names and paths carrying spaces or quotes are passed through verbatim
 * instead of being re-parsed.
 */
import { execFile } from "child_process"
import { readFile, stat } from "fs/promises"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"
import { isImagePath } from "@cockpit/feature-explorer/server/files/shared"
import { countNewFileLines, resolveInRepo } from "@cockpit/feature-explorer/server/effect/untrackedLines"

/** Which end of this branch forms the "after" side of the diff. */
export type BranchDiffMode = "head" | "worktree"

/** sha / branch / tag / `main~3` / `@{u}` — no shell metacharacters. */
const REV_PATTERN = /^[0-9A-Za-z._/^~@{}-]+$/

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

const git = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          [...args],
          { cwd, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(stdout as string))
        )
      }),
    catch: (cause) =>
      new AppError({ message: `git ${args.join(" ")} failed`, cause }),
  })

const gitOrEmpty = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<string> => git(cwd, args).pipe(Effect.orElseSucceed(() => ""))

/** Does `<rev>:<file>` resolve to a blob? Costs no content transfer. */
const blobExists = (
  cwd: string,
  rev: string,
  file: string
): Effect.Effect<boolean> =>
  git(cwd, ["cat-file", "-e", `${rev}:${file}`]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

/**
 * Fork point of HEAD and `base`. Falls back to the base tip when the two have
 * no common ancestor (unrelated histories / a base that is not an ancestor),
 * which degrades to the old two-dot behaviour rather than failing the request.
 */
const resolveMergeBase = (
  cwd: string,
  base: string
): Effect.Effect<string> =>
  git(cwd, ["merge-base", base, "HEAD"]).pipe(
    Effect.map((s) => s.trim()),
    Effect.filterOrFail(
      (s) => s.length > 0,
      () => new AppError({ message: "empty merge-base" })
    ),
    Effect.orElseSucceed(() => base)
  )

/**
 * Repo root. Needed because every path git hands back here is relative to the
 * ROOT, not to `cwd` — both `diff --name-status` and `status --porcelain` do
 * this even when invoked from a subdirectory. Resolving those against `cwd`
 * would read the wrong file (or nothing) whenever a project is opened at a
 * subdirectory of its repository.
 */
const resolveRepoRoot = (cwd: string): Effect.Effect<string> =>
  git(cwd, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((s) => s.trim()),
    Effect.filterOrFail(
      (s) => s.length > 0,
      () => new AppError({ message: "empty toplevel" })
    ),
    Effect.orElseSucceed(() => cwd)
  )

/** Untracked, non-ignored files as `added` entries. `git diff` never lists these. */
const getUntrackedFiles = (
  cwd: string,
  repoRoot: string
): Effect.Effect<FileChange[]> =>
  Effect.gen(function* () {
    const out = yield* gitOrEmpty(cwd, [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])

    const paths = out
      .split("\n")
      .filter((l) => l.startsWith("?? "))
      .map((l) => unquotePath(l.slice(3).trim()))
      .filter(Boolean)

    return yield* Effect.all(
      paths.map((p) =>
        Effect.gen(function* () {
          const abs = resolveInRepo(repoRoot, p)
          const additions = abs ? yield* countNewFileLines(abs) : 0
          return {
            path: p,
            status: "added" as const,
            additions,
            deletions: 0,
          }
        })
      ),
      { concurrency: 8 }
    )
  })

const parseNumstat = (numstat: string) => {
  const statsMap = new Map<string, { additions: number; deletions: number }>()
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
  return statsMap
}

const parseNameStatus = (
  nameStatus: string,
  statsMap: Map<string, { additions: number; deletions: number }>
) => {
  const files: FileChange[] = []
  nameStatus
    .split("\n")
    .filter(Boolean)
    .forEach((line) => {
      const parts = line.split("\t")
      if (parts.length < 2) return

      const statusCode = parts[0]
      let status: FileChange["status"]
      let filePath: string
      let oldPath: string | undefined

      if (statusCode.startsWith("R")) {
        status = "renamed"
        oldPath = unquotePath(parts[1])
        filePath = unquotePath(parts[2])
      } else {
        filePath = unquotePath(parts[1])
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

      const stats = statsMap.get(filePath) ||
        statsMap.get(oldPath || "") || { additions: 0, deletions: 0 }
      files.push({
        path: filePath,
        status,
        oldPath,
        additions: stats.additions,
        deletions: stats.deletions,
      })
    })

  return files
}

const getBranchChangedFiles = (
  cwd: string,
  repoRoot: string,
  mergeBase: string,
  mode: BranchDiffMode
) =>
  Effect.gen(function* () {
    // `git diff <mergeBase>` (no second rev) compares against the WORKING TREE,
    // which is exactly the worktree mode — staged and unstaged folded together.
    const range = mode === "head" ? [mergeBase, "HEAD"] : [mergeBase]

    const [nameStatus, numstat, untracked] = yield* Effect.all(
      [
        git(cwd, [
          "-c",
          "core.quotePath=false",
          "diff",
          ...range,
          "--name-status",
        ]),
        git(cwd, ["-c", "core.quotePath=false", "diff", ...range, "--numstat"]),
        mode === "worktree"
          ? getUntrackedFiles(cwd, repoRoot)
          : Effect.succeed([] as FileChange[]),
      ],
      { concurrency: "unbounded" }
    )

    const files = [
      ...parseNameStatus(nameStatus, parseNumstat(numstat)),
      ...untracked,
    ].sort((a, b) => a.path.localeCompare(b.path))

    return ok({ files, mode, mergeBase })
  })

const getBranchFileDiff = (
  cwd: string,
  repoRoot: string,
  mergeBase: string,
  mode: BranchDiffMode,
  file: string
) =>
  Effect.gen(function* () {
    const abs = mode === "worktree" ? resolveInRepo(repoRoot, file) : null

    /** Does the "after" side hold this file? */
    const newSideHas = (): Effect.Effect<boolean> =>
      mode === "head"
        ? blobExists(cwd, "HEAD", file)
        : Effect.promise(async () => {
            if (!abs) return false
            try {
              return (await stat(abs)).isFile()
            } catch {
              return false
            }
          })

    // Same rule as commit-diff: image bytes are never decoded into a string.
    if (isImagePath(file)) {
      const [inOld, inNew] = yield* Effect.all(
        [blobExists(cwd, mergeBase, file), newSideHas()],
        { concurrency: "unbounded" }
      )
      return ok({
        oldContent: "",
        newContent: "",
        filePath: file,
        isNew: !inOld && inNew,
        isDeleted: inOld && !inNew,
        isImage: true,
        oldRev: inOld ? mergeBase : null,
        // The worktree side has no revision to name — the client loads the
        // file itself (ETag-stat'd) instead of going through /api/git/blob.
        newRev: mode === "head" && inNew ? "HEAD" : null,
        newWorktree: mode === "worktree" && inNew,
      })
    }

    const oldContent = yield* gitOrEmpty(cwd, ["show", `${mergeBase}:${file}`])
    const newContent =
      mode === "head"
        ? yield* gitOrEmpty(cwd, ["show", `HEAD:${file}`])
        : yield* Effect.promise(async () => {
            if (!abs) return ""
            try {
              return await readFile(abs, "utf8")
            } catch {
              return ""
            }
          })

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
    const mode: BranchDiffMode = sp.get("mode") === "head" ? "head" : "worktree"

    if (!base) {
      return yield* Effect.fail(
        new ValidationError({ field: "base", reason: "missing" })
      )
    }
    // Guards the argv, not a shell: a leading "-" would be read by git as a flag.
    if (!REV_PATTERN.test(base) || base.startsWith("-")) {
      return yield* Effect.fail(
        new ValidationError({ field: "base", reason: "invalid ref" })
      )
    }

    const [mergeBase, repoRoot] = yield* Effect.all(
      [resolveMergeBase(cwd, base), resolveRepoRoot(cwd)],
      { concurrency: "unbounded" }
    )

    if (file)
      return yield* getBranchFileDiff(cwd, repoRoot, mergeBase, mode, file)
    return yield* getBranchChangedFiles(cwd, repoRoot, mergeBase, mode)
  }).pipe(Effect.withSpan("api.git.branch-diff"))
)
