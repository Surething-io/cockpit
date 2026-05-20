/**
 * /api/files/recent — P8+ migration
 *
 * Recent files list (top 15) + scroll/cursor position memory.
 */
import { Effect } from "effect"
import {
  getRecentFilesPath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

const MAX_RECENT_FILES = 15

export interface RecentFileEntry {
  path: string
  scrollLine?: number
  cursorLine?: number
  cursorCol?: number
}

function normalize(raw: unknown[]): RecentFileEntry[] {
  return raw
    .map((item) =>
      typeof item === "string" ? { path: item } : (item as RecentFileEntry)
    )
    .filter((item) => item && typeof item.path === "string" && item.path)
}

const readRecent = (cwd: string): Effect.Effect<RecentFileEntry[], FSError> =>
  Effect.gen(function* () {
    const filePath = getRecentFilesPath(cwd)
    const raw = yield* Effect.tryPromise({
      try: () => readJsonFile<unknown[]>(filePath, []),
      catch: (cause) =>
        new FSError({ path: filePath, op: "read", cause }),
    })
    return normalize(raw)
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const files = yield* readRecent(cwd)
    return ok({ files })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      file?: string
      scrollLine?: number
      cursorLine?: number
      cursorCol?: number
    }
    if (!body.cwd || !body.file) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "file",
          reason: "missing",
        })
      )
    }
    const { cwd, file, scrollLine, cursorLine, cursorCol } = body
    const filePath = getRecentFilesPath(cwd)
    let files = yield* readRecent(cwd)

    const hasPosition = scrollLine != null || cursorLine != null
    if (hasPosition) {
      const idx = files.findIndex((f) => f.path === file)
      if (idx !== -1) {
        if (scrollLine != null) files[idx].scrollLine = scrollLine
        if (cursorLine != null) files[idx].cursorLine = cursorLine
        if (cursorCol != null) files[idx].cursorCol = cursorCol
      }
    } else {
      files = files.filter((f) => f.path !== file)
      files.unshift({ path: file })
      files = files.slice(0, MAX_RECENT_FILES)
    }

    yield* Effect.tryPromise({
      try: () => writeJsonFile(filePath, files),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })

    return ok({ files })
  })
)
