/**
 * /api/git/worktree — P8+ migration
 *
 * GET: list worktrees + candidate nextPath
 * POST: 5 actions — add / remove / lock / unlock / checkout
 */
import { execFile } from "child_process"
import { promisify } from "util"
import { promises as fs } from "fs"
import { dirname, basename, join } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)

function generateRandomWord(): string {
  const consonants = "bcdfghjklmnprstvwz"
  const vowels = [
    "a", "e", "i", "o", "u",
    "ai", "au", "ea", "ee", "ia", "io", "oa", "oo", "ou", "ui",
  ]
  let word = ""
  for (let i = 0; i < 2; i++) {
    word += consonants[Math.floor(Math.random() * consonants.length)]
    word += vowels[Math.floor(Math.random() * vowels.length)]
  }
  return word
}

export interface WorktreeInfo {
  path: string
  head: string
  branch: string | null
  isDetached: boolean
  isLocked: boolean
  isBare: boolean
  /** Worktree creation time (ms epoch); null for the main repo or if undeterminable */
  createdAt: number | null
}

function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = []
  const blocks = output.trim().split("\n\n")
  for (const block of blocks) {
    if (!block.trim()) continue
    const lines = block.split("\n")
    const worktree: Partial<WorktreeInfo> = {
      isDetached: false,
      isLocked: false,
      isBare: false,
      createdAt: null,
    }
    for (const line of lines) {
      if (line.startsWith("worktree ")) worktree.path = line.substring(9)
      else if (line.startsWith("HEAD ")) worktree.head = line.substring(5)
      else if (line.startsWith("branch ")) {
        const ref = line.substring(7)
        worktree.branch = ref.replace("refs/heads/", "")
      } else if (line === "detached") worktree.isDetached = true
      else if (line === "locked") worktree.isLocked = true
      else if (line === "bare") worktree.isBare = true
    }
    if (worktree.path && worktree.head) {
      worktrees.push(worktree as WorktreeInfo)
    }
  }
  return worktrees
}

const runGit = (
  args: string[],
  cwd: string
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () => execFileAsync("git", args, { cwd }).then((r) => r.stdout),
    catch: (cause) =>
      new AppError({ message: `git command failed: git ${args.join(" ")}`, cause }),
  })

const runGitOrEmpty = (args: string[], cwd: string): Effect.Effect<string> =>
  runGit(args, cwd).pipe(Effect.orElseSucceed(() => ""))

/**
 * Resolve a worktree's creation time via its admin dir (.git/worktrees/<name>).
 * A linked worktree's `.git` is a file ("gitdir: <adminDir>"); the main repo's
 * `.git` is a directory — for which we return null (no creation semantics).
 */
const getWorktreeCreatedAt = (
  worktreePath: string
): Effect.Effect<number | null> =>
  Effect.tryPromise({
    try: async (): Promise<number | null> => {
      const dotGit = join(worktreePath, ".git")
      const st = await fs.stat(dotGit)
      if (st.isDirectory()) return null // main repo
      const content = await fs.readFile(dotGit, "utf8")
      const m = content.match(/^gitdir:\s*(.+)$/m)
      if (!m) return null
      const adminStat = await fs.stat(m[1].trim())
      const birth = adminStat.birthtimeMs
      return birth > 0 ? birth : adminStat.mtimeMs
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

const getNextWorktreePath = (
  cwd: string,
  worktrees: WorktreeInfo[]
): Effect.Effect<{ path: string; randomWord: string } | null> =>
  Effect.tryPromise({
    try: async () => {
      const mainRepoPath =
        worktrees.length > 0 ? worktrees[0].path : cwd
      const parentDir = dirname(mainRepoPath)
      const projectName = basename(mainRepoPath)
      for (let i = 0; i < 50; i++) {
        const randomWord = generateRandomWord()
        const candidatePath = join(parentDir, `${projectName}-${randomWord}`)
        try {
          await fs.access(candidatePath)
        } catch {
          return { path: candidatePath, randomWord }
        }
      }
      return null
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd()

    // Fallback response when not a git repo
    const isRepoCheck = yield* runGit(["rev-parse", "--git-dir"], cwd).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false)
    )
    if (!isRepoCheck) {
      return ok({ isGitRepo: false, worktrees: [] })
    }

    const stdout = yield* runGit(["worktree", "list", "--porcelain"], cwd)
    const worktrees = yield* Effect.forEach(
      parseWorktreeList(stdout),
      (w) =>
        getWorktreeCreatedAt(w.path).pipe(
          Effect.map((createdAt) => ({ ...w, createdAt }))
        )
    )

    const next = yield* getNextWorktreePath(cwd, worktrees)
    const gitUserName = (
      yield* runGitOrEmpty(["config", "user.name"], cwd)
    )
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")

    return ok({
      isGitRepo: true,
      worktrees,
      nextPath: next?.path ?? null,
      nextRandomWord: next?.randomWord ?? null,
      currentPath: cwd,
      gitUserName,
    })
  }).pipe(Effect.withSpan("api.git.worktree.GET"))
)

interface PostBody {
  action?: string
  cwd?: string
  path?: string
  branch?: string
  newBranch?: string
  baseBranch?: string
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as PostBody
    if (!body.cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const { action, cwd, path, branch, newBranch, baseBranch } = body

    switch (action) {
      case "add": {
        if (!path) {
          return yield* Effect.fail(
            new ValidationError({ field: "path", reason: "missing" })
          )
        }
        // Branch names and paths come from the request (and ultimately from
        // remote refs): pass them as argv, and end option parsing first.
        let args: string[]
        if (newBranch) {
          const base = baseBranch || "origin/main"
          args = ["worktree", "add", "--no-track", "-b", newBranch, "--end-of-options", path, base]
        } else if (branch) {
          const localBranch = branch.replace(/^origin\//, "")
          args = ["worktree", "add", "--end-of-options", path, localBranch]
        } else {
          return yield* Effect.fail(
            new ValidationError({
              field: "branch|newBranch",
              reason: "one is required",
            })
          )
        }
        yield* runGit(args, cwd)
        return ok({ success: true, path })
      }
      case "remove":
      case "lock":
      case "unlock": {
        if (!path) {
          return yield* Effect.fail(
            new ValidationError({ field: "path", reason: "missing" })
          )
        }
        const args =
          action === "remove"
            ? ["worktree", "remove", "--force", "--end-of-options", path]
            : ["worktree", action, "--end-of-options", path]
        yield* runGit(args, cwd)
        return ok({ success: true })
      }
      case "checkout": {
        if (!path) {
          return yield* Effect.fail(
            new ValidationError({ field: "path", reason: "missing" })
          )
        }
        if (!branch) {
          return yield* Effect.fail(
            new ValidationError({ field: "branch", reason: "missing" })
          )
        }
        const localBranch = branch.replace(/^origin\//, "")
        yield* runGit(["checkout", "--end-of-options", localBranch], path)
        return ok({ success: true })
      }
      default:
        return yield* Effect.fail(
          new ValidationError({
            field: "action",
            reason: `unknown: ${action}`,
          })
        )
    }
  }).pipe(Effect.withSpan("api.git.worktree.POST"))
)
