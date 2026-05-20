/**
 * /api/files/clipboard — P8+ migration
 *
 * Read/write "file references" via the system clipboard (osascript / PowerShell / xclip+xsel).
 */
import { stat } from "fs/promises"
import { join, resolve, sep } from "path"
import { execFile, execSync } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { isMac, isWindows } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import {
  AppError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)

async function writeClipboard(fullPath: string): Promise<void> {
  if (isMac) {
    await execFileAsync("osascript", [
      "-e",
      `set the clipboard to POSIX file "${fullPath}"`,
    ])
  } else if (isWindows) {
    execSync(
      `powershell -Command "Set-Clipboard -Value '${fullPath.replace(/'/g, "''")}'"`
    )
  } else {
    try {
      await execFileAsync("xclip", ["-selection", "clipboard"], {
        input: fullPath,
      } as never)
    } catch {
      execSync(
        `echo -n '${fullPath.replace(/'/g, "\\'")}' | xsel --clipboard`
      )
    }
  }
}

async function readClipboardPath(): Promise<string | null> {
  if (isMac) {
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        "POSIX path of (the clipboard as «class furl»)",
      ])
      return stdout.trim().replace(/\/$/, "")
    } catch {
      return null
    }
  }
  if (isWindows) {
    try {
      const result = execSync('powershell -Command "Get-Clipboard"', {
        encoding: "utf8",
        timeout: 3000,
      }).trim()
      return result && !result.includes("\n") ? result : null
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await execFileAsync("xclip", [
      "-selection",
      "clipboard",
      "-o",
    ])
    const result = stdout.trim()
    return result && !result.includes("\n") ? result : null
  } catch {
    try {
      const result = execSync("xsel --clipboard --output", {
        encoding: "utf8",
        timeout: 3000,
      }).trim()
      return result && !result.includes("\n") ? result : null
    } catch {
      return null
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
        new PermissionError({
          action: "clipboard.write",
          resource: filePath,
        })
      )
    }

    yield* Effect.tryPromise({
      try: async () => {
        await stat(fullPath)
        await writeClipboard(fullPath)
      },
      catch: (cause) =>
        new AppError({ message: "clipboard write failed", cause }),
    })

    return ok({ success: true })
  })
)

export const GET = handler(() =>
  Effect.gen(function* () {
    const clipPath = yield* Effect.tryPromise({
      try: () => readClipboardPath(),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))

    if (clipPath) {
      const valid = yield* Effect.tryPromise({
        try: () => stat(clipPath),
        catch: () => null,
      }).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false)
      )
      if (valid) return ok({ path: clipPath })
    }
    return ok({ path: null })
  })
)
