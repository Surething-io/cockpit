/**
 * Pure path helpers for /api/fs/dirs. Kept out of dirs.ts because a Next route
 * module may only export route fields, and these are what the Windows-path
 * unit tests exercise (via path.win32) on any OS.
 */
import nodePath from "path"

type PathModule = typeof nodePath.posix

export interface DirSegment {
  name: string
  path: string
}

/** "", "~" and "~/x" are relative to home; anything else is resolved against it. */
export const resolveInput = (
  input: string,
  home: string,
  p: PathModule = nodePath
): string => {
  const trimmed = input.trim()
  if (trimmed === "" || trimmed === "~") return p.resolve(home)
  if (/^~[\\/]/.test(trimmed)) return p.resolve(home, trimmed.slice(2))
  return p.resolve(home, trimmed)
}

export const toSegments = (abs: string, p: PathModule = nodePath): DirSegment[] => {
  const { root } = p.parse(abs)
  const segments: DirSegment[] = [{ name: root, path: root }]
  let current = root
  for (const name of abs.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = p.join(current, name)
    segments.push({ name, path: current })
  }
  return segments
}

export const parentOf = (abs: string, p: PathModule = nodePath): string | null => {
  const parent = p.dirname(abs)
  return parent === abs ? null : parent
}

/** Dot-dirs everywhere; on Windows also the `$Recycle.Bin`-style system dirs. */
export const isHiddenName = (name: string, platform: NodeJS.Platform): boolean =>
  name.startsWith(".") ||
  (platform === "win32" &&
    (name.startsWith("$") || name === "System Volume Information"))
