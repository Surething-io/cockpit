import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir } from 'fs/promises';
import { join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

// Get all visible files using git (tracked + untracked but not ignored)
async function getGitVisibleFiles(cwd: string): Promise<string[] | null> {
  try {
    // Get tracked files + untracked but not ignored files
    const { stdout } = await execAsync(
      '(git ls-files && git ls-files --others --exclude-standard) | sort -u',
      { cwd, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout.split('\n').filter(Boolean).map(f => f.trim());
  } catch {
    // Not a git repo or git not available
    return null;
  }
}

// Build tree from flat file paths
function buildTreeFromPaths(filePaths: string[]): FileNode[] {
  const root: FileNode[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
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

// Fallback: recursively read directory (for non-git repos)
async function readDirectoryRecursive(
  dirPath: string,
  basePath: string
): Promise<FileNode[]> {

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relativePath = relative(basePath, fullPath);

      // Skip .git directory
      if (entry.name === '.git') continue;

      const node: FileNode = {
        name: entry.name,
        path: relativePath,
        isDirectory: entry.isDirectory(),
      };

      if (entry.isDirectory()) {
        node.children = await readDirectoryRecursive(
          fullPath,
          basePath
        );
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

    // Try git-based file listing first (much faster)
    const gitFiles = await getGitVisibleFiles(cwd);

    let files: FileNode[];
    if (gitFiles !== null) {
      // Use git ls-files result - build tree from flat paths
      files = buildTreeFromPaths(gitFiles);
    } else {
      // Fallback to recursive directory reading for non-git repos
      files = await readDirectoryRecursive(targetPath, cwd);
    }

    return NextResponse.json({ files, cwd });
  } catch (error) {
    console.error('Error listing files:', error);
    return NextResponse.json(
      { error: 'Failed to list files' },
      { status: 500 }
    );
  }
}
