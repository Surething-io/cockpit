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
import { basename, join } from "path"
import {
  COCKPIT_PROJECTS_DIR,
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

/**
 * Delete an entry's sidecar output file.
 *
 * By path derived from the id, not only the recorded `outputFile`: a sidecar
 * can exist that the entry never recorded — the exit-time flush of a running
 * command, or a previous run's spill left behind by a rerun whose output
 * fitted inline. Trusting `outputFile` alone left those on disk forever.
 */
export async function removeEntryOutput(
  cwd: string,
  entry: { id?: string; outputFile?: string }
): Promise<void> {
  const paths = new Set<string>()
  if (entry.outputFile) paths.add(entry.outputFile)
  if (entry.id) paths.add(getTerminalOutputPath(cwd, entry.id))
  for (const p of paths) await fs.unlink(p).catch(() => {})
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
        await removeEntryOutput(cwd, JSON.parse(line))
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

/**
 * Sidecars younger than this are left alone: finalize writes the file first
 * and the entry that references it second, so a brand-new file may simply not
 * be referenced *yet*.
 */
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000

/**
 * Delete sidecar output files no history entry references any more.
 *
 * Deletion used to trust only an entry's recorded `outputFile`, so sidecars it
 * never recorded (exit-time flushes, a rerun's earlier spill) piled up. The
 * delete paths now remove by id; this reclaims what accumulated before that
 * and anything a crash leaves between the two writes. Runs at server start,
 * after pty-host sessions are adopted.
 *
 * A file is kept when any history file in its project dir records it as an
 * `outputFile` (compared by file name, so a symlinked data dir cannot make a
 * live reference look foreign), or it belongs to a still-running entry (reconcile attaches a
 * running command's flushed file when it turns out to be interrupted).
 */
export async function sweepOrphanOutputs(
  now: number = Date.now(),
  projectsDir: string = COCKPIT_PROJECTS_DIR
): Promise<{ removed: number; bytes: number }> {
  let removed = 0
  let bytes = 0
  let projects: string[]
  try {
    projects = await fs.readdir(projectsDir)
  } catch {
    return { removed, bytes }
  }

  for (const project of projects) {
    const dir = join(projectsDir, project)
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      continue // not a directory
    }
    const outputs = names.filter((n) => /^terminal-output-.+\.txt$/.test(n))
    if (outputs.length === 0) continue

    const keep = new Set<string>()
    for (const name of names) {
      if (!/^terminal-history-.+\.jsonl$/.test(name)) continue
      let content: string
      try {
        content = await fs.readFile(join(dir, name), "utf-8")
      } catch {
        continue
      }
      for (const line of content.split("\n")) {
        if (!line) continue
        try {
          const entry = JSON.parse(line) as HistoryEntry & { running?: boolean }
          if (entry.outputFile) keep.add(basename(entry.outputFile))
          if (entry.running && entry.id) keep.add(`terminal-output-${entry.id}.txt`)
        } catch {
          /* unparseable line references nothing */
        }
      }
    }

    for (const name of outputs) {
      if (keep.has(name)) continue
      const file = join(dir, name)
      try {
        const stat = await fs.stat(file)
        if (now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue
        await fs.unlink(file)
        removed++
        bytes += stat.size
      } catch {
        /* vanished meanwhile */
      }
    }
  }
  return { removed, bytes }
}
