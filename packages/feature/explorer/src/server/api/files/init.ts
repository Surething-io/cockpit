/**
 * /api/files/init — P8+ migration
 *
 * Initialize the file tree: readdir on root + all expanded directories, assembling a partial tree.
 */
import { stat, readdir, readlink } from "fs/promises"
import { join } from "path"
import { Effect } from "effect"
import { getExpandedPathsPath, readJsonFile } from "@cockpit/shared-utils"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
  isSymlink?: boolean
  symlinkTarget?: string
}

async function readdirWithMeta(
  cwd: string,
  relativePath: string
): Promise<FileNode[]> {
  const absPath = relativePath ? join(cwd, relativePath) : cwd
  let entries
  try {
    entries = await readdir(absPath, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (entry.name === ".git") continue

    const entryRelPath = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name
    const isSymlink = entry.isSymbolicLink()
    let isDir = entry.isDirectory()

    if (isSymlink) {
      try {
        const targetStats = await stat(join(absPath, entry.name))
        isDir = targetStats.isDirectory()
      } catch {
        /* broken symlink */
      }
    }

    nodes.push({
      name: entry.name,
      path: entryRelPath,
      isDirectory: isDir,
      ...(isSymlink ? { isSymlink: true } : {}),
    })
  }

  nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}

/** Fill in symlinkTarget across the whole tree; an unreadable link is left without one. */
function resolveSymlinkTargets(nodes: FileNode[], cwd: string): Effect.Effect<void> {
  const links: FileNode[] = []
  const collect = (list: FileNode[]) => {
    for (const node of list) {
      if (node.isSymlink) links.push(node)
      if (node.children) collect(node.children)
    }
  }
  collect(nodes)
  return Effect.forEach(
    links,
    (node) =>
      Effect.tryPromise(() => readlink(join(cwd, node.path))).pipe(
        Effect.tap((target) => Effect.sync(() => { node.symlinkTarget = target })),
        Effect.ignore
      ),
    { concurrency: "unbounded", discard: true }
  )
}

function buildPartialTree(
  cwd: string,
  expandedPaths: string[]
): Effect.Effect<FileNode[], FSError> {
  const expandedSet = new Set(expandedPaths)
  const validExpanded = expandedPaths.filter((p) => {
    const parts = p.split("/")
    for (let i = 1; i < parts.length; i++) {
      if (!expandedSet.has(parts.slice(0, i).join("/"))) return false
    }
    return true
  })

  const dirsToLoad = ["", ...validExpanded]
  return Effect.forEach(
    dirsToLoad,
    (p) =>
      Effect.tryPromise({
        try: () => readdirWithMeta(cwd, p),
        catch: (cause) => new FSError({ path: join(cwd, p), op: "read", cause }),
      }).pipe(Effect.map((nodes) => ({ path: p, nodes }))),
    { concurrency: "unbounded" }
  ).pipe(Effect.map((results) => assembleTree(results)))
}

function assembleTree(results: Array<{ path: string; nodes: FileNode[] }>): FileNode[] {
  const childrenMap = new Map<string, FileNode[]>()
  for (const { path, nodes } of results) {
    childrenMap.set(path, nodes)
  }

  const assignChildren = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.isDirectory && childrenMap.has(node.path)) {
        node.children = childrenMap.get(node.path)!
        assignChildren(node.children)
      }
    }
  }

  const root = childrenMap.get("") || []
  assignChildren(root)
  return root
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd()

    const stats = yield* Effect.tryPromise({
      try: () => stat(cwd),
      catch: (cause) => new FSError({ path: cwd, op: "stat", cause }),
    })
    if (!stats.isDirectory()) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "not a directory" })
      )
    }

    const expandedPathsFile = getExpandedPathsPath(cwd)
    const expandedPaths = yield* Effect.tryPromise({
      try: () => readJsonFile<string[]>(expandedPathsFile, []),
      catch: (cause) =>
        new FSError({ path: expandedPathsFile, op: "read", cause }),
    })

    const files = yield* buildPartialTree(cwd, expandedPaths)
    yield* resolveSymlinkTargets(files, cwd)

    return ok({ files, expandedPaths, cwd })
  })
)
