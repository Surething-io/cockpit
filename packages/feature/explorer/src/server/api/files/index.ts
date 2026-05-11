import { stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { rgPath as RG_PATH } from '@vscode/ripgrep';

const execFileAsync = promisify(execFile);

// `rgPath` is resolved by `@vscode/ripgrep` (1.18+) at import time, locating
// the binary inside the platform-specific optional dep (e.g.
// `@vscode/ripgrep-darwin-arm64/bin/rg`). Do NOT hand-build the path off
// `process.cwd()` — main package no longer ships `bin/rg` since 1.18.

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
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return Response.json({ error: 'Path is not a directory' }, { status: 400 });
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
    return Response.json({ paths });
  } catch (error) {
    console.error('Error building file index:', error);
    return Response.json({ error: 'Failed to build file index' }, { status: 500 });
  }
}
