/**
 * /api/fs/dirs — directory listing for the in-page folder picker.
 *
 * Replaces the OS-native picker (/api/pick-folder). That one had to pop a
 * desktop window out of a background server process, which broke in a
 * different way on every platform (macOS 26 refuses it foreground so Cmd+V
 * never arrives, Windows opens it behind the browser, Linux has no DISPLAY
 * under ssh/systemd) and was invisible when Cockpit is used from another
 * device. Listing directories over HTTP works everywhere the page does.
 *
 * All platform differences stay here: the client renders `segments`, `roots`
 * and `sep` as given and never splits or joins a path itself.
 *
 * Not a new exposure: /api/files/readdir already lists any `cwd`; the gate is
 * the same-origin check, as for every other route.
 */
import type { Dirent } from "fs"
import { readdir, stat } from "fs/promises"
import nodePath from "path"
import { homedir } from "os"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

type PathModule = typeof nodePath.posix

export interface DirEntry {
  name: string
  path: string
  hidden: boolean
  /** Has a `.git` entry, i.e. is a repository root. */
  git: boolean
}

export interface DirSegment {
  name: string
  path: string
}

export interface DirListing {
  /** Absolute, normalized path that was listed. */
  path: string
  /** null when `path` is a filesystem root. */
  parent: string | null
  home: string
  sep: string
  /** Breadcrumb, root first; each `path` is absolute. */
  segments: DirSegment[]
  /** Filesystem roots: ["/"] on POSIX, the mounted drives on Windows. */
  roots: string[]
  dirs: DirEntry[]
  /** Set instead of throwing so the picker can show it inline. */
  error?: "notFound" | "notDirectory" | "denied"
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

const exists = (target: string) =>
  Effect.promise(() =>
    stat(target).then(
      () => true,
      () => false
    )
  )

// A: and B: are skipped: probing a legacy floppy mapping can stall for seconds.
const windowsDrives = Effect.all(
  "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) =>
    exists(`${letter}:\\`).pipe(Effect.map((found) => (found ? `${letter}:\\` : null)))
  ),
  { concurrency: "unbounded" }
).pipe(Effect.map((drives) => drives.filter((d): d is string => d !== null)))

// Follow symlinks so a linked project dir is still enterable.
const isDir = (entry: Dirent, full: string) =>
  entry.isSymbolicLink()
    ? Effect.promise(() =>
        stat(full).then(
          (s) => s.isDirectory(),
          () => false
        )
      )
    : Effect.succeed(entry.isDirectory())

const listChildren = (abs: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(abs, { withFileTypes: true }),
      catch: (cause) => new FSError({ path: abs, op: "read", cause }),
    })
    const dirs = yield* Effect.all(
      entries.map((entry) =>
        Effect.gen(function* () {
          const full = nodePath.join(abs, entry.name)
          if (!(yield* isDir(entry, full))) return null
          return {
            name: entry.name,
            path: full,
            hidden: isHiddenName(entry.name, process.platform),
            git: yield* exists(nodePath.join(full, ".git")),
          } satisfies DirEntry
        })
      ),
      { concurrency: "unbounded" }
    )
    return dirs
      .filter((d): d is DirEntry => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  })

const errorKind = (cause: unknown): NonNullable<DirListing["error"]> => {
  const code = (cause as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return "notFound"
  if (code === "ENOTDIR") return "notDirectory"
  return "denied"
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const input = new URL(req.url).searchParams.get("path") ?? ""
    const home = homedir()
    const abs = resolveInput(input, home)

    const roots = process.platform === "win32" ? yield* windowsDrives : ["/"]
    const base: Omit<DirListing, "dirs" | "error"> = {
      path: abs,
      parent: parentOf(abs),
      home,
      sep: nodePath.sep,
      segments: toSegments(abs),
      roots,
    }

    const listing = yield* listChildren(abs).pipe(
      Effect.map((dirs): DirListing => ({ ...base, dirs })),
      Effect.catchTag("FSError", (e) =>
        Effect.succeed<DirListing>({ ...base, dirs: [], error: errorKind(e.cause) })
      )
    )
    return ok(listing)
  })
)
