import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, basename, join } from 'path';

const execAsync = promisify(exec);

// 生成随机可读单词（辅音 + 元音/韵母，2组）
function generateRandomWord(): string {
  const consonants = 'bcdfghjklmnprstvwz';
  const vowels = ['a', 'e', 'i', 'o', 'u', 'ai', 'au', 'ea', 'ee', 'ia', 'io', 'oa', 'oo', 'ou', 'ui'];

  let word = '';
  // 生成 2 组（辅音 + 元音/韵母）
  for (let i = 0; i < 2; i++) {
    word += consonants[Math.floor(Math.random() * consonants.length)];
    word += vowels[Math.floor(Math.random() * vowels.length)];
  }

  return word;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isBare: boolean;
}

// 解析 git worktree list --porcelain 输出
function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const blocks = output.trim().split('\n\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.split('\n');
    const worktree: Partial<WorktreeInfo> = {
      isDetached: false,
      isLocked: false,
      isBare: false,
    };

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree.path = line.substring(9);
      } else if (line.startsWith('HEAD ')) {
        worktree.head = line.substring(5);
      } else if (line.startsWith('branch ')) {
        // refs/heads/main -> main
        const ref = line.substring(7);
        worktree.branch = ref.replace('refs/heads/', '');
      } else if (line === 'detached') {
        worktree.isDetached = true;
      } else if (line === 'locked') {
        worktree.isLocked = true;
      } else if (line === 'bare') {
        worktree.isBare = true;
      }
    }

    if (worktree.path && worktree.head) {
      worktrees.push(worktree as WorktreeInfo);
    }
  }

  return worktrees;
}

// 生成下一个可用的 worktree 路径（格式：{主仓库父目录}/{主仓库目录名}-{随机单词}）
async function getNextWorktreePath(cwd: string, worktrees: WorktreeInfo[]): Promise<{ path: string; randomWord: string }> {
  // 主仓库是 worktree 列表中的第一个
  const mainRepoPath = worktrees.length > 0 ? worktrees[0].path : cwd;
  const parentDir = dirname(mainRepoPath);
  const projectName = basename(mainRepoPath);

  // 最多尝试 50 次生成不重复的随机单词
  for (let i = 0; i < 50; i++) {
    const randomWord = generateRandomWord();
    const candidatePath = join(parentDir, `${projectName}-${randomWord}`);
    try {
      await execAsync(`test -e "${candidatePath}"`);
      // 路径存在，继续尝试
    } catch {
      // 路径不存在，可以使用
      return { path: candidatePath, randomWord };
    }
  }

  throw new Error('No available worktree path (too many attempts)');
}

// GET: 列出所有 worktree
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // 检查是否是 git 仓库
    try {
      await execAsync('git rev-parse --git-dir', { cwd });
    } catch {
      return NextResponse.json({ isGitRepo: false, worktrees: [] });
    }

    const { stdout } = await execAsync('git worktree list --porcelain', { cwd });
    const worktrees = parseWorktreeList(stdout);

    // 获取下一个可用路径和随机单词（基于主仓库路径）
    let nextPath: string | null = null;
    let nextRandomWord: string | null = null;
    try {
      const result = await getNextWorktreePath(cwd, worktrees);
      nextPath = result.path;
      nextRandomWord = result.randomWord;
    } catch {
      // 忽略错误
    }

    // 获取 git user.name
    let gitUserName = '';
    try {
      const { stdout: userName } = await execAsync('git config user.name', { cwd });
      gitUserName = userName.trim().toLowerCase().replace(/\s+/g, '');
    } catch {
      // 忽略错误
    }

    return NextResponse.json({
      isGitRepo: true,
      worktrees,
      nextPath,
      nextRandomWord,
      currentPath: cwd,
      gitUserName,
    });
  } catch (error) {
    console.error('Error listing worktrees:', error);
    return NextResponse.json(
      { error: 'Failed to list worktrees' },
      { status: 500 }
    );
  }
}

// POST: 创建、删除、锁定、解锁 worktree
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, cwd, path, branch, newBranch, baseBranch } = body;

    if (!cwd) {
      return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
    }

    switch (action) {
      case 'add': {
        // 创建 worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        let cmd: string;
        if (newBranch) {
          // 基于 baseBranch 创建新分支（--no-track 确保不跟踪远程分支）
          const base = baseBranch || 'origin/main';
          cmd = `git worktree add --no-track -b "${newBranch}" "${path}" "${base}"`;
        } else if (branch) {
          // 使用已有分支
          // 如果是远程分支（origin/xxx），strip 前缀用本地名
          // git worktree add <path> <local-name> 会自动创建 tracking branch
          const localBranch = branch.replace(/^origin\//, '');
          cmd = `git worktree add "${path}" "${localBranch}"`;
        } else {
          return NextResponse.json({ error: 'branch or newBranch is required' }, { status: 400 });
        }

        await execAsync(cmd, { cwd });
        return NextResponse.json({ success: true, path });
      }

      case 'remove': {
        // 删除 worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        // --force 允许删除有未提交更改的 worktree
        await execAsync(`git worktree remove --force "${path}"`, { cwd });
        return NextResponse.json({ success: true });
      }

      case 'lock': {
        // 锁定 worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        await execAsync(`git worktree lock "${path}"`, { cwd });
        return NextResponse.json({ success: true });
      }

      case 'unlock': {
        // 解锁 worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        await execAsync(`git worktree unlock "${path}"`, { cwd });
        return NextResponse.json({ success: true });
      }

      case 'checkout': {
        // 在指定 worktree 中切换分支
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        if (!branch) {
          return NextResponse.json({ error: 'branch is required' }, { status: 400 });
        }
        // 远程分支 strip origin/ 前缀
        const localBranch = branch.replace(/^origin\//, '');
        await execAsync(`git checkout "${localBranch}"`, { cwd: path });
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('Error with worktree operation:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
