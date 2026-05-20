/**
 * /api/files/paste — P8+ migration
 *
 * Copies source from the system clipboard into cwd/targetDir, auto-renaming to avoid conflicts.
 */
import { stat, cp } from "fs/promises"
import { join, resolve, basename, extname } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import {
  FSError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"

async function getUniqueName(
  targetDir: string,
  originalName: string
): Promise<string> {
  const ext = extname(originalName)
  const base = basename(originalName, ext)

  try {
    await stat(join(targetDir, originalName))
  } catch {
    return originalName
  }

  let candidate = `${base} copy${ext}`
  try {
    await stat(join(targetDir, candidate))
  } catch {
    return candidate
  }

  let counter = 2
  while (counter < 100) {
    candidate = `${base} copy ${counter}${ext}`
    try {
      await stat(join(targetDir, candidate))
      counter++
    } catch {
      return candidate
    }
  }

  throw new Error("Failed to generate a unique filename")
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      targetDir?: string
      sourceAbsPath?: string
    }
    if (!body.cwd || body.targetDir == null || !body.sourceAbsPath) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd
            ? "cwd"
            : body.targetDir == null
              ? "targetDir"
              : "sourceAbsPath",
          reason: "missing",
        })
      )
    }
    const { cwd, targetDir, sourceAbsPath } = body
    const basePath = resolve(cwd)
    const targetAbsDir = resolve(join(basePath, targetDir))

    if (!targetAbsDir.startsWith(basePath)) {
      return yield* Effect.fail(
        new PermissionError({ action: "paste", resource: targetDir })
      )
    }

    const result = yield* Effect.tryPromise({
      try: async () => {
        const srcAbsPath = resolve(sourceAbsPath)
        const srcStat = await stat(srcAbsPath)
        const targetStat = await stat(targetAbsDir)
        if (!targetStat.isDirectory()) {
          throw new Error("target-not-dir")
        }
        const srcName = basename(srcAbsPath)
        const destName = await getUniqueName(targetAbsDir, srcName)
        const destPath = join(targetAbsDir, destName)
        await cp(srcAbsPath, destPath, { recursive: srcStat.isDirectory() })
        return { destName }
      },
      catch: (cause) => {
        if (cause instanceof Error && cause.message === "target-not-dir") {
          return new ValidationError({
            field: "targetDir",
            reason: "not a directory",
          })
        }
        return new FSError({
          path: sourceAbsPath,
          op: "write",
          cause,
        })
      },
    })

    const relPath = targetDir
      ? `${targetDir}/${result.destName}`
      : result.destName

    return ok({ success: true, newPath: relPath, newName: result.destName })
  })
)
