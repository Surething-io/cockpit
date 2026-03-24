import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  oldPath?: string; // Used for rename cases
}

export interface GitStatusResponse {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  cwd: string;
}

// Parse git status --porcelain=v1 output
function parseGitStatus(output: string): { staged: GitFileStatus[]; unstaged: GitFileStatus[] } {
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];

  const lines = output.split('\n').filter(line => line.trim());

  for (const line of lines) {
    if (line.length < 3) continue;

    const indexStatus = line[0]; // Staging area status
    const workTreeStatus = line[1]; // Working tree status
    let filePath = line.slice(3);

    // Strip quotes (git adds quotes to filenames containing spaces)
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    // Handle rename case (R status)
    let oldPath: string | undefined;
    if (filePath.includes(' -> ')) {
      const parts = filePath.split(' -> ');
      oldPath = parts[0];
      filePath = parts[1];
    }

    // Staging area changes
    if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push({
        path: filePath,
        status: getStatusFromCode(indexStatus),
        oldPath,
      });
    }

    // Working tree changes
    if (workTreeStatus !== ' ') {
      // Filter out pure directories (paths ending with /)
      if (filePath.endsWith('/')) {
        continue;
      }

      if (workTreeStatus === '?') {
        // Untracked file
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
    // Check if this is a git repository
    await execAsync('git rev-parse --git-dir', { cwd });

    // Get git status (-u shows all untracked files, not just directories)
    // -c core.quotePath=false prevents Chinese filenames from being escaped as octal
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
