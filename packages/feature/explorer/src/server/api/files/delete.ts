/**
 * /api/files/delete — P8+ migration
 *
 * Move to the trash (osascript / PowerShell / gio trash); on failure, fall back to rm.
 */
import { stat, rm } from "fs/promises"
import { join, resolve, sep } from "path"
import { execFile, execSync } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { isMac, isWindows } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import {
  FSError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)

async function moveToTrash(fullPath: string): Promise<void> {
  if (isMac) {
    await execFileAsync("osascript", [
      "-e",
      `tell application "Finder" to delete (POSIX file "${fullPath}" as alias)`,
    ])
  } else if (isWindows) {
    try {
      const escaped = fullPath.replace(/'/g, "''")
      execSync(
        `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin')"`,
        { timeout: 10000 }
      )
    } catch {
      const info = await stat(fullPath)
      await rm(fullPath, { recursive: info.isDirectory(), force: true })
    }
  } else {
    try {
      execSync(`gio trash "${fullPath}"`, { timeout: 5000 })
    } catch {
      const info = await stat(fullPath)
      await rm(fullPath, { recursive: info.isDirectory(), force: true })
    }
  }
}

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

    if (!fullPath.startsWith(basePath + sep)) {
      return yield* Effect.fail(
        new PermissionError({ action: "delete", resource: filePath })
      )
    }

    yield* Effect.tryPromise({
      try: async () => {
        await stat(fullPath)
        await moveToTrash(fullPath)
      },
      catch: (cause) =>
        new FSError({ path: fullPath, op: "rm", cause }),
    })

    return ok({ success: true })
  })
)
