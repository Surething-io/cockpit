/**
 * /api/files/readdir — P8+ migration
 *
 * List directory children (supports symlink target resolution).
 */
import { stat, readdir, readlink } from "fs/promises"
import { join } from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
  isSymlink?: boolean
  symlinkTarget?: string
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const path = sp.get("path") || ""

    if (path.includes("..")) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "contains '..'" })
      )
    }

    const absPath = path ? join(cwd, path) : cwd

    const nodes = yield* Effect.tryPromise({
      try: async () => {
        const stats = await stat(absPath)
        if (!stats.isDirectory()) {
          throw new Error("Path is not a directory")
        }

        const entries = await readdir(absPath, { withFileTypes: true })
        const result: FileNode[] = []

        for (const entry of entries) {
          if (entry.name === ".git") continue

          const entryRelPath = path ? `${path}/${entry.name}` : entry.name
          const isSymlink = entry.isSymbolicLink()
          let isDir = entry.isDirectory()

          if (isSymlink) {
            try {
              const targetStats = await stat(join(absPath, entry.name))
              isDir = targetStats.isDirectory()
            } catch {
              /* broken symlink */
            }
          }

          const node: FileNode = {
            name: entry.name,
            path: entryRelPath,
            isDirectory: isDir,
            ...(isSymlink ? { isSymlink: true } : {}),
          }

          if (isSymlink) {
            try {
              node.symlinkTarget = await readlink(join(absPath, entry.name))
            } catch {
              /* ignore */
            }
          }

          result.push(node)
        }

        result.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })

        return result
      },
      catch: (cause) => new FSError({ path: absPath, op: "read", cause }),
    })

    return ok({ children: nodes })
  })
)
