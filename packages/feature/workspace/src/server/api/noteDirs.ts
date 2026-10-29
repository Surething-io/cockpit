/**
 * Map a per-project data directory name (`~/.cockpit/projects/<encoded>`) back
 * to the project path it belongs to — for the notes list, which finds notes by
 * scanning those directories.
 *
 * The encoding (encodePath: every non-alphanumeric → `-`) is lossy and the
 * directory records no path of its own, so the mapping is a best effort, in
 * order:
 *   1. a KNOWN path (sidebar projects, recent sessions) that encodes to it;
 *   2. a path that exists on disk, rebuilt by walking real directories and
 *      keeping only children whose encoded names continue the prefix;
 *   3. a naive decode, every `-` read as `/`.
 * Even (3) is a usable key: the note route only ever re-encodes the path, and
 * the naive decode re-encodes to the same directory name — so reads and saves
 * hit the right file; only the displayed path may be wrong.
 *
 * Steps 2–3 assume POSIX paths; on Windows (drive-letter names) only step 1
 * matches, and a note of a project known nowhere else is left out.
 *
 * Pure apart from the injected `listDir`, so the walk is testable.
 */
import nodePath from "path"
import { encodePath } from "@cockpit/shared-utils"

/** Lists the child directory names of `dir`; [] when unreadable. Async: the
 *  walk runs inside a request handler, where sync fs is not allowed. */
export type ListDir = (dir: string) => Promise<string[]>

const encodeName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "-")

/**
 * Rebuild an existing absolute POSIX path from its encoded form by walking the
 * filesystem. Depth-first, so an ambiguous prefix (`a-b` as `a-b/` or `a/b/`)
 * tries every candidate. Undefined when nothing on disk matches.
 */
export async function resolveEncodedPath(encoded: string, listDir: ListDir): Promise<string | undefined> {
  if (!encoded.startsWith("-")) return undefined
  const walk = async (dir: string, rest: string): Promise<string | undefined> => {
    if (rest === "") return dir
    for (const child of await listDir(dir)) {
      const piece = "-" + encodeName(child)
      if (rest === piece) return nodePath.posix.join(dir, child)
      if (rest.startsWith(piece + "-")) {
        const found = await walk(nodePath.posix.join(dir, child), rest.slice(piece.length))
        if (found) return found
      }
    }
    return undefined
  }
  return walk("/", encoded)
}

export interface NoteDirMatch {
  /** Path to pass to /api/note?cwd= — always re-encodes to `dirName`. */
  cwd: string
  /** False when the path is the naive decode and may not be the real one. */
  exact: boolean
}

export async function matchNoteDir(
  dirName: string,
  knownCwds: readonly string[],
  listDir: ListDir,
): Promise<NoteDirMatch | undefined> {
  const known = knownCwds.find((cwd) => encodePath(cwd) === dirName)
  if (known) return { cwd: known, exact: true }
  const onDisk = await resolveEncodedPath(dirName, listDir)
  if (onDisk && encodePath(onDisk) === dirName) return { cwd: onDisk, exact: true }
  // Naive decode. Hash-suffixed (over-long) names cannot round-trip this way,
  // so they are skipped rather than mapped to a path that misses the file.
  const naive = "/" + dirName.slice(1).replace(/-/g, "/")
  return encodePath(naive) === dirName ? { cwd: naive, exact: false } : undefined
}
