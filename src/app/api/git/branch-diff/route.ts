import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 去除 git 对包含空格的文件名加的引号
function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1);
  }
  return path;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const base = searchParams.get('base'); // 对比的基准分支
  const file = searchParams.get('file'); // 可选：获取指定文件的 diff

  if (!base) {
    return NextResponse.json(
      { error: 'Missing base parameter' },
      { status: 400 }
    );
  }

  try {
    // 如果指定了文件，返回该文件的 diff 内容
    if (file) {
      return await getBranchFileDiff(cwd, base, file);
    }

    // 否则返回变更文件列表
    return await getBranchChangedFiles(cwd, base);
  } catch (error) {
    console.error('Error getting branch diff:', error);
    return NextResponse.json(
      { error: 'Failed to get branch diff' },
      { status: 500 }
    );
  }
}

/**
 * 获取当前 HEAD 与 base 分支之间的文件变更列表
 * 使用两点直接对比 git diff base HEAD（等同于 PR diff）
 * old=base（目标分支），new=HEAD（当前分支）
 */
async function getBranchChangedFiles(cwd: string, base: string) {
  const nameStatusCmd = `git -c core.quotePath=false diff ${base} HEAD --name-status`;
  const numstatCmd = `git -c core.quotePath=false diff ${base} HEAD --numstat`;

  const { stdout: nameStatus } = await execAsync(nameStatusCmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
  const { stdout: numstat } = await execAsync(numstatCmd, { cwd, maxBuffer: 10 * 1024 * 1024 });

  // 解析 numstat
  const statsMap = new Map<string, { additions: number; deletions: number }>();
  numstat.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      let filename = parts.slice(2).join('\t');
      filename = unquotePath(filename);
      statsMap.set(filename, { additions, deletions });
    }
  });

  // 解析 name-status
  const files: FileChange[] = [];
  nameStatus.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split('\t');
    if (parts.length < 2) return;

    const statusCode = parts[0];
    let status: FileChange['status'];
    let path: string;
    let oldPath: string | undefined;

    if (statusCode.startsWith('R')) {
      status = 'renamed';
      oldPath = unquotePath(parts[1]);
      path = unquotePath(parts[2]);
    } else {
      path = unquotePath(parts[1]);
      switch (statusCode) {
        case 'A': status = 'added'; break;
        case 'D': status = 'deleted'; break;
        case 'M':
        default: status = 'modified'; break;
      }
    }

    const stats = statsMap.get(path) || statsMap.get(oldPath || '') || { additions: 0, deletions: 0 };
    files.push({ path, status, oldPath, additions: stats.additions, deletions: stats.deletions });
  });

  return NextResponse.json({ files });
}

/**
 * 获取某个文件在当前 HEAD 与 base 分支之间的 diff
 * 方向：old=base（目标分支），new=HEAD（当前分支）
 * 等同于 PR diff：展示当前分支相对于目标分支的变更
 */
async function getBranchFileDiff(cwd: string, base: string, file: string) {
  try {
    // old = 目标分支（base）的文件内容
    let oldContent = '';
    try {
      const { stdout } = await execAsync(
        `git show ${base}:"${file}"`,
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      );
      oldContent = stdout;
    } catch {
      oldContent = '';
    }

    // new = 当前分支（HEAD）的文件内容
    let newContent = '';
    try {
      const { stdout } = await execAsync(
        `git show HEAD:"${file}"`,
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      );
      newContent = stdout;
    } catch {
      newContent = '';
    }

    const isNew = oldContent === '' && newContent !== '';
    const isDeleted = oldContent !== '' && newContent === '';

    return NextResponse.json({
      oldContent,
      newContent,
      filePath: file,
      isNew,
      isDeleted,
    });
  } catch (error) {
    console.error('Error getting branch file diff:', error);
    return NextResponse.json(
      { error: 'Failed to get branch file diff' },
      { status: 500 }
    );
  }
}
