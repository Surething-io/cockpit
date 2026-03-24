import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir } from 'fs/promises';
import { join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get all file paths via git (tracked + untracked + ignored).
 * Returns a deduplicated flat path array, or null if not a git repository.
 */
async function getGitAllPaths(cwd: string): Promise<string[] | null> {
  try {
    // Run three git commands in parallel: tracked, untracked, ignored
    const [trackedResult, untrackedResult, ignoredResult] = await Promise.all([
      execAsync(
        'git -c core.quotePath=false ls-files',
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      ),
      execAsync(
        'git -c core.quotePath=false ls-files --others --exclude-standard',
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      ),
      execAsync(
        'git -c core.quotePath=false ls-files --others --ignored --exclude-standard',
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      ).catch(() => ({ stdout: '' })), // ignored may fail (no .gitignore, etc.)
    ]);

    const paths = new Set<string>();

    for (const result of [trackedResult, untrackedResult, ignoredResult]) {
      const stdout = typeof result === 'object' && 'stdout' in result ? result.stdout : '';
      for (const line of stdout.split('\n')) {
        const p = line.trim();
        if (p) paths.add(p);
      }
    }

    return Array.from(paths).sort();
  } catch {
    return null; // Not a git repository
  }
}

/**
 * Recursively collect all file paths (fallback for non-git repositories).
 */
async function collectAllPaths(dirPath: string, basePath: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = join(dirPath, entry.name);
      const relPath = relative(basePath, fullPath);
      if (entry.isDirectory()) {
        paths.push(...await collectAllPaths(fullPath, basePath));
      } else {
        paths.push(relPath);
      }
    }
  } catch { /* ignore */ }
  return paths;
}

/**
 * GET /api/files/index?cwd=...
 * Returns { paths: string[] } — flat path array (files only)
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    // Try git approach first
    const gitPaths = await getGitAllPaths(cwd);
    if (gitPaths !== null) {
      return NextResponse.json({ paths: gitPaths });
    }

    // Non-git repository fallback: recursive readdir
    const paths = await collectAllPaths(cwd, cwd);
    paths.sort();
    return NextResponse.json({ paths });
  } catch (error) {
    console.error('Error building file index:', error);
    return NextResponse.json({ error: 'Failed to build file index' }, { status: 500 });
  }
}
