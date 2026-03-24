import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Strip quotes that git adds to filenames containing spaces
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
  const base = searchParams.get('base'); // Base branch to compare against
  const file = searchParams.get('file'); // Optional: get diff for a specific file

  if (!base) {
    return NextResponse.json(
      { error: 'Missing base parameter' },
      { status: 400 }
    );
  }

  try {
    // If a file is specified, return its diff content
    if (file) {
      return await getBranchFileDiff(cwd, base, file);
    }

    // Otherwise return the list of changed files
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
 * Get the list of changed files between the current HEAD and the base branch.
 * Uses two-dot diff: git diff base HEAD (equivalent to PR diff).
 * old=base (target branch), new=HEAD (current branch)
 */
async function getBranchChangedFiles(cwd: string, base: string) {
  const nameStatusCmd = `git -c core.quotePath=false diff ${base} HEAD --name-status`;
  const numstatCmd = `git -c core.quotePath=false diff ${base} HEAD --numstat`;

  const { stdout: nameStatus } = await execAsync(nameStatusCmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
  const { stdout: numstat } = await execAsync(numstatCmd, { cwd, maxBuffer: 10 * 1024 * 1024 });

  // Parse numstat
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

  // Parse name-status
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
 * Get the diff for a file between the current HEAD and the base branch.
 * Direction: old=base (target branch), new=HEAD (current branch).
 * Equivalent to PR diff: shows changes in the current branch relative to the target branch.
 */
async function getBranchFileDiff(cwd: string, base: string, file: string) {
  try {
    // old = file content in the target branch (base)
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

    // new = file content in the current branch (HEAD)
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
