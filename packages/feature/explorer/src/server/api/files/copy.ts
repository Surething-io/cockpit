/**
 * /api/files/copy
 *
 * Copy a file: file.ts -> file-copy.ts -> file-copy-2.ts ...
 * Includes path-traversal safety checks (returns PermissionError 403).
 */
import { copyFile, stat } from "fs/promises"
import { join, resolve, dirname, basename, extname } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import {
  FSError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      path?: string
    }
    if (!body.cwd || !body.path) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "path",
          reason: "missing",
        })
      )
    }
    const { cwd, path: filePath } = body
    const basePath = resolve(cwd)
    const fullPath = resolve(join(basePath, filePath))

    if (!fullPath.startsWith(basePath + "/")) {
      return yield* Effect.fail(
        new PermissionError({
          action: "copy",
          resource: filePath,
        })
      )
    }

    const dir = dirname(fullPath)
    const ext = extname(fullPath)
    const base = basename(fullPath, ext)

    // Find the next available file-copy[-N].ext
    const destPath = yield* Effect.sync(() => {
      const destName = `${base}-copy${ext}`
      const candidate = join(dir, destName)
      const counter = 2
      // Synchronous probe via fs.statSync avoids an async loop here;
      // the outer layer is still wrapped in Effect.tryPromise.
      return { destName, candidate, counter }
    })

    // Rename loop
    const finalPath = yield* Effect.tryPromise({
      try: async () => {
        let destName = destPath.destName
        let candidate = destPath.candidate
        let counter = destPath.counter
        try {
          await stat(candidate)
          while (true) {
            destName = `${base}-copy-${counter}${ext}`
            candidate = join(dir, destName)
            try {
              await stat(candidate)
              counter++
            } catch {
              break
            }
          }
        } catch {
          // file-copy.ext does not exist, use it as-is
        }
        await copyFile(fullPath, candidate)
        return { destName, candidate }
      },
      catch: (cause) =>
        new FSError({ path: fullPath, op: "write", cause }),
    })

    const relDir = dirname(filePath)
    const newRelPath =
      relDir === "." ? finalPath.destName : `${relDir}/${finalPath.destName}`

    return ok({ success: true, newPath: newRelPath })
  })
)
