/**
 * Line counts for untracked files — the "+N" git would report if they were
 * added. `git diff --numstat` never lists untracked files, so every view that
 * shows per-file stats (status tab, branch diff) has to count them by hand.
 *
 * Computed by reading the file rather than `git diff --no-index /dev/null <f>`,
 * which would mean one subprocess per file and exits non-zero by design.
 *
 * Every untracked file gets a count — an earlier version stopped counting past
 * 500 files, which in a notes vault with ~1.7k untracked files left every "A"
 * row bare. The status route runs on each file-watcher tick, so results are
 * cached by (path, size, mtime): steady state costs one stat per file.
 */
import { createReadStream } from "fs"
import { stat } from "fs/promises"
import path from "path"
import { Effect } from "effect"

/** git's own binary sniff window: a NUL in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000

/** Bound on cached entries; cleared wholesale when exceeded. */
const MAX_CACHE_ENTRIES = 50_000

const cache = new Map<string, { size: number; mtimeMs: number; lines: number }>()

/** Working-tree absolute path, refusing anything that escapes the repo root. */
export const resolveInRepo = (root: string, file: string): string | null => {
  const abs = path.resolve(root, file)
  const base = path.resolve(root)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return abs
}

/** Stream the file, counting "\n"; 0 for binary (git prints "-" for those). */
const countLinesStreaming = (abs: string): Promise<number> =>
  new Promise((resolve) => {
    let lines = 0
    let seen = 0
    let last = -1
    const stream = createReadStream(abs)
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      if (seen < BINARY_SNIFF_BYTES) {
        const head = buf.subarray(0, BINARY_SNIFF_BYTES - seen)
        if (head.includes(0)) {
          stream.destroy()
          resolve(0)
          return
        }
      }
      seen += buf.length
      let i = buf.indexOf(10)
      while (i !== -1) {
        lines++
        i = buf.indexOf(10, i + 1)
      }
      if (buf.length > 0) last = buf[buf.length - 1]
    })
    stream.on("end", () => resolve(last !== -1 && last !== 10 ? lines + 1 : lines))
    stream.on("error", () => resolve(0))
  })

/**
 * Number of lines in a brand-new file, or 0 when it is binary, empty, or
 * unreadable.
 */
export const countNewFileLines = (abs: string): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      const st = await stat(abs)
      if (!st.isFile() || st.size === 0) return 0
      const hit = cache.get(abs)
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines
      const lines = await countLinesStreaming(abs)
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
      cache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, lines })
      return lines
    } catch {
      return 0
    }
  })
