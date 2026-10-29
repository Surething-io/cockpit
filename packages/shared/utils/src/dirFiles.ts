/**
 * Browse one directory for a read-only file view: list its files, read one of
 * them. Used by the skills and Bots boards, whose items are directories (a
 * SKILL.md / BOT.md plus the references, scripts and reports next to it).
 *
 * Callers resolve the directory from their own registry (never from a client-
 * supplied path); `readFileWithin` then refuses anything that resolves outside
 * it — after resolving symlinks, so a link inside cannot reach out.
 *
 * Node-only (fs). Imported by subpath (`@cockpit/shared-utils/dirFiles`), not
 * through the barrel, so client bundles never pull it in.
 */
import { readdir, readFile, realpath, stat } from "fs/promises"
import nodePath from "path"
import { isPathWithin } from "./pathWithin"

/** Enough for the largest real skill / Bot directory (~140 files) with room to spare. */
const MAX_FILES = 2000
const MAX_DEPTH = 8
/** Larger files are listed but not served. */
export const MAX_FILE_BYTES = 1024 * 1024
const SKIP_DIRS = new Set(["node_modules", "__pycache__"])

export interface DirFileEntry {
  /** POSIX path relative to the skill directory. */
  path: string
  size: number
}

/**
 * Every regular file under `dir`, sorted. Skipped: dot-entries, dependency
 * dirs, and symlinks (a Dirent for a link is neither file nor directory) —
 * so the tree never even shows a link that points out of the skill.
 */
export async function listDirFiles(dir: string): Promise<{ files: DirFileEntry[]; truncated: boolean }> {
  const files: DirFileEntry[] = []
  let truncated = false
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES) { truncated = true; return }
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue
      const childAbs = nodePath.join(abs, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) await walk(childAbs, childRel, depth + 1)
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) { truncated = true; return }
        const size = await stat(childAbs).then((s) => s.size, () => 0)
        files.push({ path: childRel, size })
      }
    }
  }
  await walk(dir, "", 0)
  return { files, truncated }
}

export type DirFileRead =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary" | "tooLarge"; size: number }
  | { kind: "outside" | "missing" }

/** Read `rel` inside `dir`; refuses anything that resolves outside it. */
export async function readFileWithin(dir: string, rel: string): Promise<DirFileRead> {
  const realDir = await realpath(dir).catch(() => null)
  const realFile = await realpath(nodePath.resolve(dir, rel)).catch(() => null)
  if (!realDir || !realFile) return { kind: "missing" }
  if (!isPathWithin(realDir, realFile)) return { kind: "outside" }
  const info = await stat(realFile).catch(() => null)
  if (!info?.isFile()) return { kind: "missing" }
  if (info.size > MAX_FILE_BYTES) return { kind: "tooLarge", size: info.size }
  const buf = await readFile(realFile)
  // A NUL byte in the first 8 KB: treat as binary, as git does.
  if (buf.subarray(0, 8192).includes(0)) return { kind: "binary", size: info.size }
  return { kind: "text", content: buf.toString("utf-8"), size: info.size }
}
