/**
 * /api/files/save — P8+ migration
 *
 * Atomic file write: tmp → rename; mtime conflict detection → 409; symlinks write through to the real target.
 */
import {
  writeFile,
  mkdir,
  stat,
  lstat,
  realpath,
  rename,
  unlink,
  chmod,
} from "fs/promises"
import { join, dirname } from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

interface SaveBody {
  cwd?: string
  path?: string
  content?: string
  createDir?: boolean
  expectedMtime?: number
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as SaveBody
    if (!body.path) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }
    const basePath = body.cwd || process.cwd()
    const fullPath = join(basePath, body.path)

    if (body.createDir) {
      yield* Effect.tryPromise({
        try: () => mkdir(fullPath, { recursive: true }),
        catch: (cause) =>
          new FSError({ path: fullPath, op: "mkdir", cause }),
      })
      return ok({ success: true })
    }

    if (body.content === undefined || body.content === null) {
      return yield* Effect.fail(
        new ValidationError({ field: "content", reason: "required" })
      )
    }
    const content = body.content

    // Conflict detection (409)
    if (body.expectedMtime !== undefined && body.expectedMtime !== null) {
      const currentMtime = yield* Effect.tryPromise({
        try: () => stat(fullPath).then((s) => s.mtimeMs),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null))

      if (
        currentMtime !== null &&
        Math.abs(currentMtime - body.expectedMtime) > 1
      ) {
        return new Response(
          JSON.stringify({
            success: false,
            conflict: true,
            currentMtime,
            expectedMtime: body.expectedMtime,
            message: "File was modified externally",
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }
        )
      }
    }

    const newMtime = yield* Effect.tryPromise({
      try: async () => {
        // Symlink protection
        let writePath = fullPath
        try {
          const lstats = await lstat(fullPath)
          if (lstats.isSymbolicLink()) {
            writePath = await realpath(fullPath)
          }
        } catch {
          /* new file */
        }

        const dir = dirname(writePath)
        await mkdir(dir, { recursive: true })

        let originalMode: number | undefined
        try {
          const st = await stat(writePath)
          originalMode = st.mode
        } catch {
          /* new file */
        }

        // Atomic write
        const tmpPath = `${writePath}.${randomUUID()}.tmp`
        try {
          await writeFile(tmpPath, content, "utf-8")
          if (originalMode !== undefined) {
            await chmod(tmpPath, originalMode)
          }
          await rename(tmpPath, writePath)
        } catch (error) {
          try {
            await unlink(tmpPath)
          } catch {
            /* ignore */
          }
          throw error
        }

        const newStats = await stat(fullPath)
        return newStats.mtimeMs
      },
      catch: (cause) =>
        new FSError({ path: fullPath, op: "write", cause }),
    })

    return ok({ success: true, mtime: newMtime })
  })
)
