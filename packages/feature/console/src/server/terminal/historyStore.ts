/**
 * Terminal-history JSONL primitives.
 *
 * Extracted from the /api/terminal/history route because a second caller now
 * needs them: the CLI bubble lifecycle (/api/browser/open|close) writes the
 * exact same entries the console UI writes. Two copies of the 100-entry cap /
 * output-spill / idempotency rules is precisely how a bubble ends up persisted
 * in one shape and broadcast in another, so the rules live here only.
 *
 * Plain promises rather than Effect: this is the same code that used to sit
 * inside the route's `Effect.tryPromise`, and both callers still wrap it
 * (the route in FSError, httpApi.ts in its own try/catch).
 */
import fs from "fs/promises"
import {
  getTerminalHistoryPath,
  getTerminalOutputPath,
  ensureParentDir,
} from "@cockpit/shared-utils"

export interface HistoryEntry {
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
  /**
   * Browser bubbles opened by `cockpit browser open`: the bubble connects its
   * bridge WS on mount instead of waiting for a click on the shortId badge,
   * so the CLI can drive it immediately. Persisted (not just broadcast) so a
   * UI reload mid-automation brings the bubble back still drivable.
   */
  autoConnect?: boolean
}

/** Outputs above this spill into a sidecar file to keep the JSONL small. */
const OUTPUT_FILE_THRESHOLD = 4096

/** Per-tab history cap. Oldest entries (and their sidecar files) are evicted. */
const MAX_ENTRIES = 100

/**
 * Append one entry. Idempotent on `entry.id` — re-appending a known id is a
 * no-op reported as `skipped`, which callers use to suppress a duplicate
 * broadcast.
 */
export async function appendHistoryEntry(
  cwd: string,
  tabId: string,
  entry: HistoryEntry
): Promise<{ success: boolean; skipped?: boolean }> {
  const historyPath = getTerminalHistoryPath(cwd, tabId)
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
    if (alreadyExists) return { success: true, skipped: true }
  }

  if (existingLines.length >= MAX_ENTRIES) {
    const removedLines = existingLines.slice(
      0,
      existingLines.length - (MAX_ENTRIES - 1)
    )
    for (const line of removedLines) {
      try {
        const old = JSON.parse(line)
        if (old.outputFile) await fs.unlink(old.outputFile).catch(() => {})
      } catch {
        /* ignore */
      }
    }
    existingLines = existingLines.slice(-(MAX_ENTRIES - 1))
  }

  existingLines.push(JSON.stringify(entryToSave))
  await fs.writeFile(historyPath, existingLines.join("\n") + "\n", "utf-8")
  return { success: true }
}

/**
 * Remove one entry by id, returning it (or null when absent).
 *
 * `onMatch` runs while the line is being dropped and BEFORE the file is
 * rewritten — the terminal route relies on that ordering to tombstone a still
 * running command inside `killCommand`, so its exit handler cannot re-persist
 * the entry into the file we just rewrote.
 */
export async function removeHistoryEntry(
  cwd: string,
  tabId: string,
  id: string,
  onMatch?: (entry: HistoryEntry) => void | Promise<void>
): Promise<HistoryEntry | null> {
  const historyPath = getTerminalHistoryPath(cwd, tabId)
  let removed: HistoryEntry | null = null
  try {
    const content = await fs.readFile(historyPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    const remaining: string[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry
        if (entry.id === id) {
          removed = entry
          if (onMatch) await onMatch(entry)
          continue
        }
      } catch {
        /* keep unparseable lines verbatim */
      }
      remaining.push(line)
    }
    if (remaining.length > 0) {
      await fs.writeFile(historyPath, remaining.join("\n") + "\n", "utf-8")
    } else {
      await fs.unlink(historyPath).catch(() => {})
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  return removed
}

/** Read every entry for a tab. Missing file → empty list. */
export async function readHistoryEntries(
  cwd: string,
  tabId: string
): Promise<HistoryEntry[]> {
  const historyPath = getTerminalHistoryPath(cwd, tabId)
  try {
    const content = await fs.readFile(historyPath, "utf-8")
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HistoryEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
