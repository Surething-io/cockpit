import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir, lstat, readlink, realpath } from 'fs/promises';
import { join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isSymlink?: boolean;
  symlinkTarget?: string;
}

interface GitFileEntry {
  path: string;
  isSymlink: boolean;
}

// Get all visible files using git (tracked + untracked but not ignored + .env files)
// Uses git ls-files -s to detect symlinks (mode 120000)
async function getGitVisibleFiles(cwd: string): Promise<GitFileEntry[] | null> {
  try {
    // 两个 git 命令互不依赖，并行执行
    const [stagedResult, untrackedResult] = await Promise.all([
      // git ls-files -s 输出格式: "mode hash stage\tpath"
      // mode 120000 = symlink
      execAsync(
        'git -c core.quotePath=false ls-files -s',
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      ),
      // Untracked + .env files
      // 使用 -c core.quotePath=false 避免中文文件名被转义为八进制
      execAsync(
        '(git -c core.quotePath=false ls-files --others --exclude-standard && find . -name ".env*" \\( -type f -o -type l \\) 2>/dev/null | sed "s|^\\./||") | sort -u',
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      ),
    ]);

    const entries = new Map<string, boolean>();
    for (const line of stagedResult.stdout.split('\n')) {
      if (!line) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) continue;
      const mode = line.substring(0, 6);
      const path = line.substring(tabIdx + 1).trim();
      if (path) entries.set(path, mode === '120000');
    }

    // Untracked 文件无法从 git 获取 mode，需要 lstat 检测 symlink
    const untrackedPaths: string[] = [];
    for (const line of untrackedResult.stdout.split('\n')) {
      const p = line.trim();
      if (p && !entries.has(p)) {
        untrackedPaths.push(p);
      }
    }

    // 批量 lstat 检测 untracked 文件是否为 symlink
    await Promise.all(untrackedPaths.map(async (p) => {
      try {
        const lstats = await lstat(join(cwd, p));
        entries.set(p, lstats.isSymbolicLink());
      } catch {
        entries.set(p, false);
      }
    }));

    return Array.from(entries.entries()).map(([path, isSymlink]) => ({ path, isSymlink }));
  } catch {
    // Not a git repo or git not available
    return null;
  }
}

// Build tree from flat file entries (with symlink info)
function buildTreeFromEntries(fileEntries: GitFileEntry[]): FileNode[] {
  const root: FileNode[] = [];

  for (const entry of fileEntries) {
    const parts = entry.path.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find(n => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: isLast ? undefined : [],
          ...(isLast && entry.isSymlink ? { isSymlink: true } : {}),
        };
        currentLevel.push(existing);
      }

      if (!isLast && existing.children) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort recursively: directories first, then alphabetically
  const sortNodes = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) {
        sortNodes(node.children);
      }
    }
  };

  sortNodes(root);
  return root;
}

// Batch resolve symlink targets via readlink
async function resolveSymlinkTargets(nodes: FileNode[], cwd: string): Promise<void> {
  const promises: Promise<void>[] = [];

  const traverse = (list: FileNode[]) => {
    for (const node of list) {
      if (node.isSymlink) {
        promises.push(
          readlink(join(cwd, node.path))
            .then(target => { node.symlinkTarget = target; })
            .catch(() => {}) // broken symlink — target string unavailable
        );
      }
      if (node.children) traverse(node.children);
    }
  };

  traverse(nodes);
  await Promise.all(promises);
}

// Fallback: recursively read directory (for non-git repos)
// visitedRealPaths tracks canonical paths to prevent symlink cycles
async function readDirectoryRecursive(
  dirPath: string,
  basePath: string,
  visitedRealPaths?: Set<string>
): Promise<FileNode[]> {

  try {
    // Cycle detection: resolve to real path and check if already visited
    if (!visitedRealPaths) visitedRealPaths = new Set();
    try {
      const realDir = await realpath(dirPath);
      if (visitedRealPaths.has(realDir)) return []; // cycle — stop recursion
      visitedRealPaths.add(realDir);
    } catch {
      // dirPath doesn't exist (broken symlink target) — stop
      return [];
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relativePath = relative(basePath, fullPath);

      // Skip .git directory
      if (entry.name === '.git') continue;

      const isSymlink = entry.isSymbolicLink();

      // For symlinks, check if target is a directory via stat (follows link)
      let isDir = false;
      if (isSymlink) {
        try {
          const targetStats = await stat(fullPath);
          isDir = targetStats.isDirectory();
        } catch {
          // Broken symlink — treat as file
        }
      } else {
        isDir = entry.isDirectory();
      }

      const node: FileNode = {
        name: entry.name,
        path: relativePath,
        isDirectory: isDir,
        ...(isSymlink ? { isSymlink: true } : {}),
      };

      if (isDir) {
        node.children = await readDirectoryRecursive(fullPath, basePath, visitedRealPaths);
        // Only include directory if it has children
        if (node.children.length > 0) {
          nodes.push(node);
        }
      } else {
        nodes.push(node);
      }
    }

    // Sort: directories first, then alphabetically
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
    return [];
  }
}

// Post-process git tree: expand symlink-to-directory nodes with their filesystem children
// git ls-files only lists the symlink itself (mode 120000), not the files inside the target dir
async function expandSymlinkDirs(nodes: FileNode[], cwd: string, visitedRealPaths: Set<string>): Promise<void> {
  const sortNodes = (list: FileNode[]) => {
    list.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  };

  for (const node of nodes) {
    // Symlink leaf node — check if it points to a directory
    if (node.isSymlink && !node.isDirectory) {
      try {
        const fullPath = join(cwd, node.path);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          const realDir = await realpath(fullPath);
          if (!visitedRealPaths.has(realDir)) {
            node.isDirectory = true;
            // Pass a copy — readDirectoryRecursive will add realDir itself at entry
            node.children = await readDirectoryRecursive(fullPath, cwd, new Set(visitedRealPaths));
            // Mark visited AFTER call, to prevent sibling symlinks to the same target
            visitedRealPaths.add(realDir);
          } else {
            // Cycle detected — show as empty expandable directory
            node.isDirectory = true;
            node.children = [];
          }
        }
      } catch {
        // Broken symlink or inaccessible — leave as leaf file
      }
    }

    // Recurse into existing directory children (may contain nested symlinks)
    if (node.children && node.children.length > 0) {
      await expandSymlinkDirs(node.children, cwd, visitedRealPaths);
    }
  }

  // Re-sort after some nodes may have changed from file → directory
  sortNodes(nodes);
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const path = searchParams.get('path') || '';

  try {
    const targetPath = path ? join(cwd, path) : cwd;

    // Verify directory exists
    const stats = await stat(targetPath);
    if (!stats.isDirectory()) {
      return NextResponse.json(
        { error: 'Path is not a directory' },
        { status: 400 }
      );
    }

    // Seed visited paths with cwd to prevent symlinks pointing back to project root
    const visitedRealPaths = new Set<string>();
    try { visitedRealPaths.add(await realpath(cwd)); } catch {}

    // Try git-based file listing first (much faster)
    const gitFiles = await getGitVisibleFiles(cwd);

    let files: FileNode[];
    if (gitFiles !== null) {
      // Use git ls-files result - build tree from flat entries
      files = buildTreeFromEntries(gitFiles);
      // Expand symlink-to-directory nodes with their filesystem children
      await expandSymlinkDirs(files, cwd, visitedRealPaths);
    } else {
      // Fallback to recursive directory reading for non-git repos
      files = await readDirectoryRecursive(targetPath, cwd, visitedRealPaths);
    }

    // Resolve symlink targets in parallel
    await resolveSymlinkTargets(files, cwd);

    return NextResponse.json({ files, cwd });
  } catch (error) {
    console.error('Error listing files:', error);
    return NextResponse.json(
      { error: 'Failed to list files' },
      { status: 500 }
    );
  }
}
