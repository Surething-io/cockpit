import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir, readlink } from 'fs/promises';
import { join } from 'path';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isSymlink?: boolean;
  symlinkTarget?: string;
}

/**
 * GET /api/files/readdir?cwd=...&path=src/components
 * Returns direct children of the specified directory { children: FileNode[] }
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const path = searchParams.get('path') || '';

  // Safety check: disallow .. traversal
  if (path.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    const absPath = path ? join(cwd, path) : cwd;

    const stats = await stat(absPath);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const entries = await readdir(absPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (entry.name === '.git') continue;

      const entryRelPath = path ? `${path}/${entry.name}` : entry.name;
      const isSymlink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();

      if (isSymlink) {
        try {
          const targetStats = await stat(join(absPath, entry.name));
          isDir = targetStats.isDirectory();
        } catch {
          // broken symlink
        }
      }

      const node: FileNode = {
        name: entry.name,
        path: entryRelPath,
        isDirectory: isDir,
        ...(isSymlink ? { isSymlink: true } : {}),
      };

      // Resolve symlink target
      if (isSymlink) {
        try {
          node.symlinkTarget = await readlink(join(absPath, entry.name));
        } catch { /* ignore */ }
      }

      nodes.push(node);
    }

    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ children: nodes });
  } catch (error) {
    console.error('Error reading directory:', error);
    return NextResponse.json({ error: 'Failed to read directory' }, { status: 500 });
  }
}
