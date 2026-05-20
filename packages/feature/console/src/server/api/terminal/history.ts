/**
 * /api/terminal/history — P8+ migration (GET/POST/PATCH/DELETE)
 *
 * JSONL persistence for terminal command history (long outputs spill to separate files; 100-entry cap).
 */
import fs from "fs/promises"
import { Effect } from "effect"
import {
  getTerminalHistoryPath,
  getTerminalOutputPath,
  ensureParentDir,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const OUTPUT_FILE_THRESHOLD = 4096

interface HistoryEntry {
  type?: "command" | "browser" | "database"
  id: string
  timestamp: string
  command?: string
  output?: string
  outputFile?: string
  exitCode?: number
  cwd?: string
  usePty?: boolean
  url?: string
  sleeping?: boolean
  connectionString?: string
  displayName?: string
}

// ─────────────────────────────────────────────────────────
// GET — paginated read
// ─────────────────────────────────────────────────────────

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const tabId = sp.get("tabId")
    const page = parseInt(sp.get("page") || "0", 10)
    const pageSize = parseInt(sp.get("pageSize") || "20", 10)

    if (!cwd || !tabId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? "cwd" : "tabId",
          reason: "missing",
        })
      )
    }

    const historyPath = getTerminalHistoryPath(cwd, tabId)
    const result = yield* Effect.tryPromise({
      try: async () => {
        let content: string
        try {
          content = await fs.readFile(historyPath, "utf-8")
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            return {
              entries: [],
              total: 0,
              page: 0,
              pageSize,
              hasMore: false,
            }
          }
          throw e
        }
        const lines = content.trim().split("\n").filter(Boolean)
        const allEntries: HistoryEntry[] = lines
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          })
          .filter(Boolean) as HistoryEntry[]

        const start = page * pageSize
        const end = start + pageSize
        const entries = allEntries.slice(start, end)

        for (const entry of entries) {
          if (entry.outputFile) {
            try {
              entry.output = await fs.readFile(entry.outputFile, "utf-8")
            } catch {
              entry.output = "[Output file deleted]"
            }
            delete entry.outputFile
          }
        }

        return {
          entries,
          total: allEntries.length,
          page,
          pageSize,
          hasMore: end < allEntries.length,
        }
      },
      catch: (cause) =>
        new FSError({ path: historyPath, op: "read", cause }),
    })
    return ok(result)
  })
)

// ─────────────────────────────────────────────────────────
// DELETE — single entry or full tab clear
// ─────────────────────────────────────────────────────────

export const DELETE = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const tabId = sp.get("tabId")
    const commandId = sp.get("commandId")

    if (!cwd || !tabId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? "cwd" : "tabId",
          reason: "missing",
        })
      )
    }

    const historyPath = getTerminalHistoryPath(cwd, tabId)
    yield* Effect.tryPromise({
      try: async () => {
        if (commandId) {
          // Delete single
          try {
            const content = await fs.readFile(historyPath, "utf-8")
            const lines = content.trim().split("\n").filter(Boolean)
            const remaining: string[] = []
            for (const line of lines) {
              try {
                const entry = JSON.parse(line)
                if (entry.id === commandId) {
                  if (entry.outputFile) {
                    await fs.unlink(entry.outputFile).catch(() => {})
                  }
                  continue
                }
              } catch {
                /* keep unparseable */
              }
              remaining.push(line)
            }
            if (remaining.length > 0) {
              await fs.writeFile(
                historyPath,
                remaining.join("\n") + "\n",
                "utf-8"
              )
            } else {
              await fs.unlink(historyPath).catch(() => {})
            }
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          }
        } else {
          // Clear all
          try {
            const content = await fs.readFile(historyPath, "utf-8")
            const lines = content.trim().split("\n").filter(Boolean)
            for (const line of lines) {
              try {
                const entry = JSON.parse(line)
                if (entry.outputFile) {
                  await fs.unlink(entry.outputFile).catch(() => {})
                }
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* file may not exist */
          }
          try {
            await fs.unlink(historyPath)
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          }
        }
      },
      catch: (cause) =>
        new FSError({ path: historyPath, op: "rm", cause }),
    })
    return ok({ success: true })
  })
)

// ─────────────────────────────────────────────────────────
// POST — append entry (100-cap + output-file overflow + idempotency)
// ─────────────────────────────────────────────────────────

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      tabId?: string
      entry?: HistoryEntry
    }
    if (!body.cwd || !body.tabId || !body.entry) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|tabId|entry",
          reason: "missing",
        })
      )
    }
    const { cwd, tabId, entry } = body
    const historyPath = getTerminalHistoryPath(cwd, tabId)

    const result = yield* Effect.tryPromise({
      try: async () => {
        await ensureParentDir(historyPath)
        const entryToSave: HistoryEntry = { ...entry }
        if (entry.output && entry.output.length > OUTPUT_FILE_THRESHOLD) {
          const outputPath = getTerminalOutputPath(cwd, entry.id)
          await fs.writeFile(outputPath, entry.output, "utf-8")
          entryToSave.output = ""
          entryToSave.outputFile = outputPath
        }

        let existingLines: string[] = []
        try {
          const content = await fs.readFile(historyPath, "utf-8")
          existingLines = content.trim().split("\n").filter(Boolean)
        } catch {
          /* file does not exist */
        }

        if (entry.id) {
          const alreadyExists = existingLines.some((line) => {
            try {
              return JSON.parse(line).id === entry.id
            } catch {
              return false
            }
          })
          if (alreadyExists) {
            return { success: true, skipped: true }
          }
        }

        if (existingLines.length >= 100) {
          const removedLines = existingLines.slice(
            0,
            existingLines.length - 99
          )
          for (const line of removedLines) {
            try {
              const old = JSON.parse(line)
              if (old.outputFile) {
                await fs.unlink(old.outputFile).catch(() => {})
              }
            } catch {
              /* ignore */
            }
          }
          existingLines = existingLines.slice(-99)
        }

        existingLines.push(JSON.stringify(entryToSave))
        await fs.writeFile(
          historyPath,
          existingLines.join("\n") + "\n",
          "utf-8"
        )
        return { success: true }
      },
      catch: (cause) =>
        new FSError({ path: historyPath, op: "write", cause }),
    })
    return ok(result)
  })
)

// ─────────────────────────────────────────────────────────
// PATCH — update single entry fields (e.g. sleeping state)
// ─────────────────────────────────────────────────────────

export const PATCH = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      tabId?: string
      id?: string
      fields?: Record<string, unknown>
    }
    if (!body.cwd || !body.tabId || !body.id || !body.fields) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|tabId|id|fields",
          reason: "missing",
        })
      )
    }
    const { cwd, tabId, id, fields } = body
    const historyPath = getTerminalHistoryPath(cwd, tabId)

    const result = yield* Effect.tryPromise({
      try: async () => {
        try {
          const content = await fs.readFile(historyPath, "utf-8")
          const lines = content.trim().split("\n").filter(Boolean)
          let updated = false
          const newLines = lines.map((line) => {
            try {
              const entry = JSON.parse(line)
              if (entry.id === id) {
                updated = true
                return JSON.stringify({ ...entry, ...fields })
              }
            } catch {
              /* keep original */
            }
            return line
          })
          if (updated) {
            await fs.writeFile(
              historyPath,
              newLines.join("\n") + "\n",
              "utf-8"
            )
          }
          return { success: true, updated }
        } catch (e: unknown) {
          if (
            e instanceof Error &&
            "code" in e &&
            (e as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            return { success: true, updated: false }
          }
          throw e
        }
      },
      catch: (cause) =>
        new FSError({ path: historyPath, op: "write", cause }),
    })
    return ok(result)
  })
)
