import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // 获取当前分支
    const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });

    // 获取所有本地分支
    const { stdout: localBranches } = await execAsync('git branch --format="%(refname:short)"', { cwd });

    // 获取所有远程分支
    const { stdout: remoteBranches } = await execAsync('git branch -r --format="%(refname:short)"', { cwd });

    // 获取当前分支的 upstream（parent）分支
    let upstream = '';
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref @{upstream}', { cwd });
      upstream = stdout.trim();
    } catch {
      // 没有设置 upstream，fallback 到 origin/main
      upstream = 'origin/main';
    }

    const local = localBranches
      .split('\n')
      .map(b => b.trim())
      .filter(Boolean);

    const remote = remoteBranches
      .split('\n')
      .map(b => b.trim())
      .filter(Boolean)
      .filter(b => !b.includes('HEAD')); // 排除 origin/HEAD

    return NextResponse.json({
      current: currentBranch.trim(),
      upstream,
      local,
      remote,
    });
  } catch (error) {
    console.error('Error getting branches:', error);
    return NextResponse.json(
      { error: 'Failed to get branches' },
      { status: 500 }
    );
  }
}
