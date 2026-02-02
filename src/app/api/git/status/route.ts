import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  oldPath?: string; // 用于重命名的情况
}

export interface GitStatusResponse {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  cwd: string;
}

// 解析 git status --porcelain=v1 输出
function parseGitStatus(output: string): { staged: GitFileStatus[]; unstaged: GitFileStatus[] } {
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];

  const lines = output.split('\n').filter(line => line.trim());

  for (const line of lines) {
    if (line.length < 3) continue;

    const indexStatus = line[0]; // 暂存区状态
    const workTreeStatus = line[1]; // 工作区状态
    let filePath = line.slice(3);

    // 去除引号（git 对包含空格的文件名会加引号）
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    // 处理重命名情况 (R 状态)
    let oldPath: string | undefined;
    if (filePath.includes(' -> ')) {
      const parts = filePath.split(' -> ');
      oldPath = parts[0];
      filePath = parts[1];
    }

    // 暂存区变更
    if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push({
        path: filePath,
        status: getStatusFromCode(indexStatus),
        oldPath,
      });
    }

    // 工作区变更
    if (workTreeStatus !== ' ') {
      // 过滤掉纯目录（以 / 结尾的路径）
      if (filePath.endsWith('/')) {
        continue;
      }

      if (workTreeStatus === '?') {
        // 未跟踪文件
        unstaged.push({
          path: filePath,
          status: 'untracked',
        });
      } else {
        unstaged.push({
          path: filePath,
          status: getStatusFromCode(workTreeStatus),
        });
      }
    }
  }

  return { staged, unstaged };
}

function getStatusFromCode(code: string): GitFileStatus['status'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case '?':
      return 'untracked';
    default:
      return 'modified';
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // 检查是否是 git 仓库
    await execAsync('git rev-parse --git-dir', { cwd });

    // 获取 git status (-u 显示所有未跟踪文件，而不只是目录)
    // -c core.quotePath=false 避免中文文件名被转义为八进制
    const { stdout } = await execAsync('git -c core.quotePath=false status --porcelain=v1 -u', { cwd });
    const { staged, unstaged } = parseGitStatus(stdout);

    return NextResponse.json({
      staged,
      unstaged,
      cwd,
    } as GitStatusResponse);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.message?.includes('not a git repository')) {
      return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
    }
    console.error('Error getting git status:', error);
    return NextResponse.json({ error: 'Failed to get git status' }, { status: 500 });
  }
}
