/**
 * /api/files/index
 *
 * Two ripgrep passes:
 *  1. Default (respects .gitignore) plus hidden files
 *  2. .env* files (even when gitignored)
 * Results are merged, deduplicated, and returned.
 */
import { stat } from "fs/promises"
import { execFile } from "child_process"
import { promisify } from "util"
import { rgPath as RG_PATH } from "@vscode/ripgrep"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)
const RG_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }

async function rgFiles(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(RG_PATH, args, {
      cwd,
      ...RG_OPTIONS,
    })
    return stdout.split("\n").filter(Boolean)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      if (err.code === 1) return []
      if (
        err.code === 2 &&
        "stdout" in err &&
        typeof err.stdout === "string" &&
        err.stdout
      ) {
        return err.stdout.split("\n").filter(Boolean)
      }
    }
    throw err
  }
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd()

    yield* Effect.tryPromise({
      try: async () => {
        const stats = await stat(cwd)
        if (!stats.isDirectory()) throw new Error("not-a-directory")
      },
      catch: (cause) => {
        if (cause instanceof Error && cause.message === "not-a-directory") {
          return new ValidationError({
            field: "cwd",
            reason: "not a directory",
          })
        }
        return new FSError({ path: cwd, op: "stat", cause })
      },
    })

    const [mainFiles, envFiles] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () =>
            rgFiles(cwd, [
              "--files",
              "--hidden",
              "--follow",
              "--glob",
              "!.git",
            ]),
          catch: (cause) =>
            new FSError({ path: cwd, op: "read", cause }),
        }),
        Effect.tryPromise({
          try: () =>
            rgFiles(cwd, [
              "--files",
              "--no-ignore",
              "--hidden",
              "--follow",
              "--glob",
              ".env*",
              "--glob",
              "!.git",
              "--glob",
              "!node_modules",
            ]),
          catch: (cause) =>
            new FSError({ path: cwd, op: "read", cause }),
        }),
      ],
      { concurrency: "unbounded" }
    )

    const paths = [...new Set([...mainFiles, ...envFiles])].sort()
    return ok({ paths })
  })
)
