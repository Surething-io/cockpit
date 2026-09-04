/**
 * /api/terminal/history — P8+ migration (GET/POST/PATCH/DELETE)
 *
 * JSONL persistence for terminal command history (long outputs spill to separate files; 100-entry cap).
 */
import fs from "fs/promises"
import { Effect } from "effect"
import { getTerminalHistoryPath } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import {
  reconcileOrphanedRunning,
  killCommand,
  getRunningCommands,
} from "../../terminal/RunningCommandRegistry"
import { broadcastConsoleDelta } from "../../terminal/consoleBroadcast"
import {
  appendHistoryEntry,
  removeHistoryEntry,
  type HistoryEntry,
} from "../../terminal/historyStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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

    // Turn orphaned running:true placeholders (left by a previous server) into
    // finished bubbles before reading, so a restart doesn't blank the console.
    if (page === 0) {
      yield* Effect.tryPromise({
        try: () => reconcileOrphanedRunning(cwd, tabId),
        catch: () => null,
      }).pipe(Effect.catchAll(() => Effect.void))
    }

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
    const sourceId = sp.get("sourceId") ?? undefined

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
          // Delete single. The onMatch hook runs before the file is rewritten:
          // killCommand tombstones the process so its onExit cannot re-persist
          // the entry we are dropping.
          await removeHistoryEntry(cwd, tabId, commandId, async (entry) => {
            // Kill the backend process (if still running) so closing a bubble
            // actually ends it.
            killCommand(commandId)
            if (entry.outputFile) {
              await fs.unlink(entry.outputFile).catch(() => {})
            }
          })
        } else {
          // Clear all — kill every running backend process for this tab first,
          // otherwise "clear" leaves orphaned processes that the registry
          // re-surfaces as bubbles on the next refresh.
          for (const c of getRunningCommands(cwd)) {
            if (c.tabId === tabId) killCommand(c.commandId)
          }
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
    broadcastConsoleDelta(
      cwd,
      tabId,
      commandId ? { op: "delete", id: commandId } : { op: "clear" },
      sourceId
    )
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
      sourceId?: string
    }
    if (!body.cwd || !body.tabId || !body.entry) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|tabId|entry",
          reason: "missing",
        })
      )
    }
    const { cwd, tabId, entry, sourceId } = body
    const historyPath = getTerminalHistoryPath(cwd, tabId)

    const result = yield* Effect.tryPromise({
      try: () => appendHistoryEntry(cwd, tabId, entry),
      catch: (cause) =>
        new FSError({ path: historyPath, op: "write", cause }),
    })
    // Sync the new bubble to other tabs (skip if it was a dup no-op).
    if (result.success && !("skipped" in result && result.skipped)) {
      broadcastConsoleDelta(
        cwd,
        tabId,
        { op: "add", entry: entry as unknown as Record<string, unknown> },
        sourceId
      )
    }
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
      sourceId?: string
    }
    if (!body.cwd || !body.tabId || !body.id || !body.fields) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|tabId|id|fields",
          reason: "missing",
        })
      )
    }
    const { cwd, tabId, id, fields, sourceId } = body
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
    if (result.updated) {
      broadcastConsoleDelta(cwd, tabId, { op: "update", id, fields }, sourceId)
    }
    return ok(result)
  })
)
