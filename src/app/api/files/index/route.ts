import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir } from 'fs/promises';
import { join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 通过 git 获取所有文件路径（tracked + untracked + ignored）
 * 返回去重后的扁平路径数组，或 null（非 git 仓库）
 */
async function getGitAllPaths(cwd: string): Promise<string[] | null> {
  try {
    // 三个 git 命令并行：tracked、untracked、ignored
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
      ).catch(() => ({ stdout: '' })), // ignored 可能失败（无 .gitignore 等）
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
    return null; // 非 git 仓库
  }
}

/**
 * 递归收集所有文件路径（非 git 仓库 fallback）
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
 * 返回 { paths: string[] } — 扁平路径数组（仅文件）
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    // 尝试 git 方式
    const gitPaths = await getGitAllPaths(cwd);
    if (gitPaths !== null) {
      return NextResponse.json({ paths: gitPaths });
    }

    // 非 git 仓库 fallback：递归 readdir
    const paths = await collectAllPaths(cwd, cwd);
    paths.sort();
    return NextResponse.json({ paths });
  } catch (error) {
    console.error('Error building file index:', error);
    return NextResponse.json({ error: 'Failed to build file index' }, { status: 500 });
  }
}
