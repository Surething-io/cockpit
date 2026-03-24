import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // Get current branch
    const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });

    // Get all local branches
    const { stdout: localBranches } = await execAsync('git branch --format="%(refname:short)"', { cwd });

    // Get all remote branches
    const { stdout: remoteBranches } = await execAsync('git branch -r --format="%(refname:short)"', { cwd });

    // Get the upstream (parent) branch of the current branch
    let upstream = '';
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref @{upstream}', { cwd });
      upstream = stdout.trim();
    } catch {
      // No upstream set, fall back to origin/main
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
      .filter(b => !b.includes('HEAD')); // Exclude origin/HEAD

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
