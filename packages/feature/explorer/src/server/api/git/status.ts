import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  oldPath?: string; // Used for rename cases
  /** Lines added — from `git diff --numstat`. 0 for untracked / binary / unmatched. */
  additions?: number;
  /** Lines deleted — from `git diff --numstat`. 0 for untracked / binary / unmatched. */
  deletions?: number;
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

/**
 * Parse `git diff --numstat` output into a path → {additions, deletions} map.
 * Format per line: `<additions>\t<deletions>\t<path>`.
 * Binary files report `-\t-\t<path>` and are skipped (left as undefined → 0 in UI).
 * For renames, numstat may emit `path/{old => new}` form; we normalize to the new path.
 */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  const lines = output.split('\n').filter(line => line.trim());
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...rest] = parts;
    if (addRaw === '-' || delRaw === '-') continue; // binary
    let path = rest.join('\t');
    // Strip surrounding quotes if present
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    // Handle rename form: dir/{old => new}/file.ts  →  dir/new/file.ts
    const renameMatch = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (renameMatch) {
      path = `${renameMatch[1]}${renameMatch[3]}${renameMatch[4]}`.replace(/\/+/g, '/');
    }
    map.set(path, {
      additions: Number.parseInt(addRaw, 10) || 0,
      deletions: Number.parseInt(delRaw, 10) || 0,
    });
  }
  return map;
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

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // Check if this is a git repository
    await execAsync('git rev-parse --git-dir', { cwd });

    // Get git status (-u shows all untracked files, not just directories)
    // -c core.quotePath=false prevents Chinese filenames from being escaped as octal
    const { stdout } = await execAsync('git -c core.quotePath=false status --porcelain=v1 -u', { cwd });
    const { staged, unstaged } = parseGitStatus(stdout);

    // Fetch numstat for line-level statistics. Run in parallel; failures (e.g.
    // initial commit edge cases) degrade gracefully to empty maps so the
    // primary status response is unaffected.
    const [stagedNumstat, unstagedNumstat] = await Promise.all([
      execAsync('git -c core.quotePath=false diff --cached --numstat', { cwd })
        .then(r => parseNumstat(r.stdout))
        .catch(() => new Map<string, { additions: number; deletions: number }>()),
      execAsync('git -c core.quotePath=false diff --numstat', { cwd })
        .then(r => parseNumstat(r.stdout))
        .catch(() => new Map<string, { additions: number; deletions: number }>()),
    ]);

    for (const file of staged) {
      const stat = stagedNumstat.get(file.path);
      if (stat) {
        file.additions = stat.additions;
        file.deletions = stat.deletions;
      }
    }
    for (const file of unstaged) {
      const stat = unstagedNumstat.get(file.path);
      if (stat) {
        file.additions = stat.additions;
        file.deletions = stat.deletions;
      }
    }

    return Response.json({
      staged,
      unstaged,
      cwd,
    } as GitStatusResponse);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.message?.includes('not a git repository')) {
      return Response.json({ error: 'Not a git repository' }, { status: 400 });
    }
    console.error('Error getting git status:', error);
    return Response.json({ error: 'Failed to get git status' }, { status: 500 });
  }
}
