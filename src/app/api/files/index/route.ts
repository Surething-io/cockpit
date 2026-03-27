import { NextRequest, NextResponse } from 'next/server';
import { stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const RG_PATH = join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');

const RG_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 10000 };

async function rgFiles(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(RG_PATH, args, { cwd, ...RG_OPTIONS });
    return stdout.split('\n').filter(Boolean);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      // exit 1 = no files found
      if (err.code === 1) return [];
      // exit 2 = errors (e.g. broken symlink) but may still have partial results
      if (err.code === 2 && 'stdout' in err && typeof err.stdout === 'string' && err.stdout) {
        return err.stdout.split('\n').filter(Boolean);
      }
    }
    throw err;
  }
}

/**
 * GET /api/files/index?cwd=...
 * Returns { paths: string[] } — flat path array (files only)
 *
 * Two ripgrep passes, merged and deduplicated:
 * 1. rg --files --hidden --glob '!.git'        → all files respecting .gitignore
 * 2. rg --files --no-ignore --glob '.env*'      → .env* files even if gitignored
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    // Run two searches in parallel
    const [mainFiles, envFiles] = await Promise.all([
      // Main: respects .gitignore, includes hidden files
      rgFiles(cwd, ['--files', '--hidden', '--follow', '--glob', '!.git']),
      // Supplement: .env* files that may be gitignored
      rgFiles(cwd, ['--files', '--no-ignore', '--hidden', '--follow', '--glob', '.env*', '--glob', '!.git', '--glob', '!node_modules']),
    ]);

    // Deduplicate and sort
    const paths = [...new Set([...mainFiles, ...envFiles])].sort();
    return NextResponse.json({ paths });
  } catch (error) {
    console.error('Error building file index:', error);
    return NextResponse.json({ error: 'Failed to build file index' }, { status: 500 });
  }
}
