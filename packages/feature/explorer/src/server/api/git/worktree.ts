/**
 * /api/git/worktree — P8+ migration
 *
 * GET: list worktrees + candidate nextPath
 * POST: 5 actions — add / remove / lock / unlock / checkout
 */
import { exec } from "child_process"
import { promisify } from "util"
import { dirname, basename, join } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

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
  cmd: string,
  cwd: string
): Effect.Effect<string, AppError> =>
  Effect.tryPromise({
    try: () => execAsync(cmd, { cwd }).then((r) => r.stdout),
    catch: (cause) =>
      new AppError({ message: `git command failed: ${cmd}`, cause }),
  })

const runGitOrEmpty = (cmd: string, cwd: string): Effect.Effect<string> =>
  runGit(cmd, cwd).pipe(Effect.orElseSucceed(() => ""))

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
          await execAsync(`test -e "${candidatePath}"`)
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
    const isRepoCheck = yield* runGit("git rev-parse --git-dir", cwd).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false)
    )
    if (!isRepoCheck) {
      return ok({ isGitRepo: false, worktrees: [] })
    }

    const stdout = yield* runGit("git worktree list --porcelain", cwd)
    const worktrees = parseWorktreeList(stdout)

    const next = yield* getNextWorktreePath(cwd, worktrees)
    const gitUserName = (
      yield* runGitOrEmpty("git config user.name", cwd)
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
        let cmd: string
        if (newBranch) {
          const base = baseBranch || "origin/main"
          cmd = `git worktree add --no-track -b "${newBranch}" "${path}" "${base}"`
        } else if (branch) {
          const localBranch = branch.replace(/^origin\//, "")
          cmd = `git worktree add "${path}" "${localBranch}"`
        } else {
          return yield* Effect.fail(
            new ValidationError({
              field: "branch|newBranch",
              reason: "one is required",
            })
          )
        }
        yield* runGit(cmd, cwd)
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
        const cmd =
          action === "remove"
            ? `git worktree remove --force "${path}"`
            : action === "lock"
              ? `git worktree lock "${path}"`
              : `git worktree unlock "${path}"`
        yield* runGit(cmd, cwd)
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
        yield* runGit(`git checkout "${localBranch}"`, path)
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
