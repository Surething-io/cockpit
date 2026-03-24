import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, basename, join } from 'path';

const execAsync = promisify(exec);

// Generate a random readable word (consonant + vowel/rhyme, 2 groups)
function generateRandomWord(): string {
  const consonants = 'bcdfghjklmnprstvwz';
  const vowels = ['a', 'e', 'i', 'o', 'u', 'ai', 'au', 'ea', 'ee', 'ia', 'io', 'oa', 'oo', 'ou', 'ui'];

  let word = '';
  // Generate 2 groups (consonant + vowel/rhyme)
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

// Parse git worktree list --porcelain output
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

// Generate the next available worktree path (format: {main repo parent dir}/{main repo name}-{random word})
async function getNextWorktreePath(cwd: string, worktrees: WorktreeInfo[]): Promise<{ path: string; randomWord: string }> {
  // Main repo is the first entry in the worktree list
  const mainRepoPath = worktrees.length > 0 ? worktrees[0].path : cwd;
  const parentDir = dirname(mainRepoPath);
  const projectName = basename(mainRepoPath);

  // Try up to 50 times to generate a non-duplicate random word
  for (let i = 0; i < 50; i++) {
    const randomWord = generateRandomWord();
    const candidatePath = join(parentDir, `${projectName}-${randomWord}`);
    try {
      await execAsync(`test -e "${candidatePath}"`);
      // Path exists, keep trying
    } catch {
      // Path does not exist, can be used
      return { path: candidatePath, randomWord };
    }
  }

  throw new Error('No available worktree path (too many attempts)');
}

// GET: List all worktrees
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // Check if this is a git repository
    try {
      await execAsync('git rev-parse --git-dir', { cwd });
    } catch {
      return NextResponse.json({ isGitRepo: false, worktrees: [] });
    }

    const { stdout } = await execAsync('git worktree list --porcelain', { cwd });
    const worktrees = parseWorktreeList(stdout);

    // Get next available path and random word (based on main repo path)
    let nextPath: string | null = null;
    let nextRandomWord: string | null = null;
    try {
      const result = await getNextWorktreePath(cwd, worktrees);
      nextPath = result.path;
      nextRandomWord = result.randomWord;
    } catch {
      // Ignore error
    }

    // Get git user.name
    let gitUserName = '';
    try {
      const { stdout: userName } = await execAsync('git config user.name', { cwd });
      gitUserName = userName.trim().toLowerCase().replace(/\s+/g, '');
    } catch {
      // Ignore error
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

// POST: Create, remove, lock, or unlock a worktree
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, cwd, path, branch, newBranch, baseBranch } = body;

    if (!cwd) {
      return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
    }

    switch (action) {
      case 'add': {
        // Create worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        let cmd: string;
        if (newBranch) {
          // Create new branch based on baseBranch (--no-track ensures no remote tracking)
          const base = baseBranch || 'origin/main';
          cmd = `git worktree add --no-track -b "${newBranch}" "${path}" "${base}"`;
        } else if (branch) {
          // Use existing branch.
          // If it is a remote branch (origin/xxx), strip the prefix to get the local name.
          // git worktree add <path> <local-name> will auto-create a tracking branch.
          const localBranch = branch.replace(/^origin\//, '');
          cmd = `git worktree add "${path}" "${localBranch}"`;
        } else {
          return NextResponse.json({ error: 'branch or newBranch is required' }, { status: 400 });
        }

        await execAsync(cmd, { cwd });
        return NextResponse.json({ success: true, path });
      }

      case 'remove': {
        // Remove worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        // --force allows removing a worktree with uncommitted changes
        await execAsync(`git worktree remove --force "${path}"`, { cwd });
        return NextResponse.json({ success: true });
      }

      case 'lock': {
        // Lock worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        await execAsync(`git worktree lock "${path}"`, { cwd });
        return NextResponse.json({ success: true });
      }

      case 'unlock': {
        // Unlock worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }

        await execAsync(`git worktree unlock "${path}"`, { cwd });
        return NextResponse.json({ success: true });
      }

      case 'checkout': {
        // Switch branch in the specified worktree
        if (!path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        if (!branch) {
          return NextResponse.json({ error: 'branch is required' }, { status: 400 });
        }
        // Strip origin/ prefix from remote branch
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
