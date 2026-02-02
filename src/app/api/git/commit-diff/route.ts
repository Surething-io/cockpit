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
  const hash = searchParams.get('hash');
  const file = searchParams.get('file');

  if (!hash) {
    return NextResponse.json(
      { error: 'Missing hash parameter' },
      { status: 400 }
    );
  }

  try {
    // 如果指定了文件，返回该文件的 diff 内容
    if (file) {
      return await getFileDiff(cwd, hash, file);
    }

    // 否则返回变更文件列表
    return await getChangedFiles(cwd, hash);
  } catch (error) {
    console.error('Error getting commit diff:', error);
    return NextResponse.json(
      { error: 'Failed to get commit diff' },
      { status: 500 }
    );
  }
}

async function getChangedFiles(cwd: string, hash: string) {
  // 检查是否为 merge commit（有多个父提交）
  const { stdout: parentCount } = await execAsync(
    `git rev-list --parents -n 1 ${hash}`,
    { cwd }
  );
  const parents = parentCount.trim().split(' ').slice(1);
  const isMergeCommit = parents.length > 1;

  // 获取变更文件列表及状态
  // 对于 merge commit，使用 git diff 与第一个父提交比较
  // 对于普通 commit，使用 git show
  let nameStatusCmd: string;
  let numstatCmd: string;

  // -c core.quotePath=false 避免中文文件名被转义为八进制
  if (isMergeCommit) {
    // 对于 merge commit，显示与第一个父提交的差异
    nameStatusCmd = `git -c core.quotePath=false diff ${hash}^1 ${hash} --name-status`;
    numstatCmd = `git -c core.quotePath=false diff ${hash}^1 ${hash} --numstat`;
  } else {
    nameStatusCmd = `git -c core.quotePath=false show ${hash} --name-status --format=""`;
    numstatCmd = `git -c core.quotePath=false show ${hash} --numstat --format=""`;
  }

  const { stdout: nameStatus } = await execAsync(
    nameStatusCmd,
    { cwd, maxBuffer: 10 * 1024 * 1024 }
  );

  const { stdout: numstat } = await execAsync(
    numstatCmd,
    { cwd, maxBuffer: 10 * 1024 * 1024 }
  );

  // 解析 numstat (additions, deletions, filename)
  const statsMap = new Map<string, { additions: number; deletions: number }>();
  numstat.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      let filename = parts.slice(2).join('\t'); // 处理文件名中可能有 tab 的情况
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
      // 重命名: R100\told_name\tnew_name
      status = 'renamed';
      oldPath = unquotePath(parts[1]);
      path = unquotePath(parts[2]);
    } else {
      path = unquotePath(parts[1]);
      switch (statusCode) {
        case 'A':
          status = 'added';
          break;
        case 'D':
          status = 'deleted';
          break;
        case 'M':
        default:
          status = 'modified';
          break;
      }
    }

    const stats = statsMap.get(path) || statsMap.get(oldPath || '') || { additions: 0, deletions: 0 };

    files.push({
      path,
      status,
      oldPath,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  });

  return NextResponse.json({ files });
}

async function getFileDiff(cwd: string, hash: string, file: string) {
  try {
    // 获取该提交的第一个父提交（对于 merge commit 也适用）
    const { stdout: parentHash } = await execAsync(
      `git rev-parse ${hash}^1`,
      { cwd }
    ).catch(() => ({ stdout: '' }));

    const parent = parentHash.trim();

    // 获取旧文件内容（从父提交）
    let oldContent = '';
    if (parent) {
      try {
        const { stdout } = await execAsync(
          `git show ${parent}:${file}`,
          { cwd, maxBuffer: 10 * 1024 * 1024 }
        );
        oldContent = stdout;
      } catch {
        // 文件在父提交中不存在（新增文件）
        oldContent = '';
      }
    }

    // 获取新文件内容（从当前提交）
    let newContent = '';
    try {
      const { stdout } = await execAsync(
        `git show ${hash}:${file}`,
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      );
      newContent = stdout;
    } catch {
      // 文件在当前提交中不存在（删除文件）
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
    console.error('Error getting file diff:', error);
    return NextResponse.json(
      { error: 'Failed to get file diff' },
      { status: 500 }
    );
  }
}
