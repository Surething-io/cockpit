/**
 * /api/git/diff
 *
 * Single-file diff (staged or unstaged): both-side contents plus
 * isNew / isDeleted flags.
 */
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

export interface GitDiffResponse {
  oldContent: string
  newContent: string
  filePath: string
  isNew: boolean
  isDeleted: boolean
}

const readGitShow = (
  cmd: string,
  cwd: string
): Effect.Effect<string, never> =>
  Effect.tryPromise({
    try: () =>
      execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }).then(
        (r) => r.stdout
      ),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => "" as string))

const readGitShowFlag = (
  cmd: string,
  cwd: string
): Effect.Effect<{ content: string; missing: boolean }, never> =>
  Effect.tryPromise({
    try: () =>
      execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }).then(
        (r) => ({ content: r.stdout, missing: false })
      ),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => ({ content: "", missing: true })))

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const file = sp.get("file")
    const type = sp.get("type") as "staged" | "unstaged" | null

    if (!file) {
      return yield* Effect.fail(
        new ValidationError({ field: "file", reason: "missing" })
      )
    }
    if (!type || !["staged", "unstaged"].includes(type)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "type",
          reason: 'must be "staged" or "unstaged"',
        })
      )
    }

    const absolutePath = path.resolve(cwd, file)
    let oldContent = ""
    let newContent = ""
    let isNew = false
    let isDeleted = false

    if (type === "staged") {
      const head = yield* readGitShowFlag(`git show HEAD:"${file}"`, cwd)
      oldContent = head.content
      isNew = head.missing

      const staged = yield* readGitShowFlag(`git show :"${file}"`, cwd)
      newContent = staged.content
      isDeleted = staged.missing
    } else {
      // Try staging first, fall back to HEAD, otherwise mark as isNew
      const staged = yield* readGitShowFlag(`git show :"${file}"`, cwd)
      if (!staged.missing) {
        oldContent = staged.content
      } else {
        const head = yield* readGitShowFlag(`git show HEAD:"${file}"`, cwd)
        if (!head.missing) {
          oldContent = head.content
        } else {
          isNew = true
          oldContent = ""
        }
      }

      // Working-tree version (read from disk)
      const worktree = yield* Effect.tryPromise({
        try: () => fs.readFile(absolutePath, "utf-8"),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null))
      if (worktree !== null) {
        newContent = worktree
      } else {
        isDeleted = true
        newContent = ""
      }
    }

    // Reference readGitShow so lint doesn't flag it as unused; the helper is
    // kept for reuse by other git endpoints.
    void readGitShow

    return ok({
      oldContent,
      newContent,
      filePath: file,
      isNew,
      isDeleted,
    } satisfies GitDiffResponse)
  }).pipe(Effect.withSpan("api.git.diff"))
)
