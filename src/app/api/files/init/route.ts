import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir, readlink } from 'fs/promises';
import { join } from 'path';
import { getExpandedPathsPath, readJsonFile } from '@/lib/paths';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isSymlink?: boolean;
  symlinkTarget?: string;
}

/**
 * readdir a single directory layer, returning FileNode[] (subdirectories default to children: undefined).
 * Skips .git, detects symlinks, sorts (directories first + alphabetical).
 */
async function readdirWithMeta(cwd: string, relativePath: string): Promise<FileNode[]> {
  const absPath = relativePath ? join(cwd, relativePath) : cwd;
  let entries;
  try {
    entries = await readdir(absPath, { withFileTypes: true });
  } catch {
    return []; // Directory does not exist or no permission
  }

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name === '.git') continue;

    const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const isSymlink = entry.isSymbolicLink();
    let isDir = entry.isDirectory();

    if (isSymlink) {
      try {
        const targetStats = await stat(join(absPath, entry.name));
        isDir = targetStats.isDirectory();
      } catch {
        // broken symlink — treat as file
      }
    }

    const node: FileNode = {
      name: entry.name,
      path: entryRelPath,
      isDirectory: isDir,
      ...(isSymlink ? { isSymlink: true } : {}),
    };

    nodes.push(node);
  }

  nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/**
 * Resolve symlink targets (batch parallel).
 */
async function resolveSymlinkTargets(nodes: FileNode[], cwd: string): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const node of nodes) {
    if (node.isSymlink) {
      promises.push(
        readlink(join(cwd, node.path))
          .then(target => { node.symlinkTarget = target; })
          .catch(() => {})
      );
    }
    if (node.children) resolveSymlinkTargets(node.children, cwd);
  }
  await Promise.all(promises);
}

/**
 * Build partial tree from expandedPaths:
 * - readdir root directory + each expanded directory
 * - Unexpanded directories keep children: undefined (lazy-load placeholder)
 */
async function buildPartialTree(cwd: string, expandedPaths: string[]): Promise<FileNode[]> {
  const expandedSet = new Set(expandedPaths);

  // Filter to valid expanded paths: parent chain must also be in expanded set (otherwise invisible)
  const validExpanded = expandedPaths.filter(p => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (!expandedSet.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  });

  // Parallel readdir of root + all expanded directories
  const dirsToLoad = ['', ...validExpanded];
  const results = await Promise.all(
    dirsToLoad.map(p => readdirWithMeta(cwd, p).then(nodes => ({ path: p, nodes })))
  );

  // Build path → children mapping
  const childrenMap = new Map<string, FileNode[]>();
  for (const { path, nodes } of results) {
    childrenMap.set(path, nodes);
  }

  // Recursively assemble tree: fill children for expanded directories
  const assignChildren = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.isDirectory && childrenMap.has(node.path)) {
        node.children = childrenMap.get(node.path)!;
        assignChildren(node.children);
      }
      // Unexpanded directory: keep children as undefined
    }
  };

  const root = childrenMap.get('') || [];
  assignChildren(root);

  return root;
}

/**
 * GET /api/files/init?cwd=...
 * Returns { files, expandedPaths, cwd }
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // Validate that cwd exists and is a directory
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    // Read persisted expanded paths
    const expandedPathsFile = getExpandedPathsPath(cwd);
    const expandedPaths = await readJsonFile<string[]>(expandedPathsFile, []);

    // Build partial tree
    const files = await buildPartialTree(cwd, expandedPaths);

    // Resolve symlink targets
    await resolveSymlinkTargets(files, cwd);

    return NextResponse.json({ files, expandedPaths, cwd });
  } catch (error) {
    console.error('Error initializing file tree:', error);
    return NextResponse.json({ error: 'Failed to initialize file tree' }, { status: 500 });
  }
}
