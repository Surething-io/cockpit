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
  const hash = searchParams.get('hash');
  const file = searchParams.get('file');

  if (!hash) {
    return NextResponse.json(
      { error: 'Missing hash parameter' },
      { status: 400 }
    );
  }

  try {
    // If a file is specified, return its diff content
    if (file) {
      return await getFileDiff(cwd, hash, file);
    }

    // Otherwise return the list of changed files
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
  // Check if this is a merge commit (has multiple parent commits)
  const { stdout: parentCount } = await execAsync(
    `git rev-list --parents -n 1 ${hash}`,
    { cwd }
  );
  const parents = parentCount.trim().split(' ').slice(1);
  const isMergeCommit = parents.length > 1;

  // Get list of changed files and their status.
  // For merge commits, use git diff against the first parent commit.
  // For regular commits, use git show.
  let nameStatusCmd: string;
  let numstatCmd: string;

  // -c core.quotePath=false prevents Chinese filenames from being escaped as octal
  if (isMergeCommit) {
    // For merge commits, show diff against the first parent commit
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

  // Parse numstat (additions, deletions, filename)
  const statsMap = new Map<string, { additions: number; deletions: number }>();
  numstat.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      let filename = parts.slice(2).join('\t'); // Handle filenames that may contain tabs
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
      // Rename: R100\told_name\tnew_name
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
    // Get the first parent commit of this commit (also works for merge commits)
    const { stdout: parentHash } = await execAsync(
      `git rev-parse ${hash}^1`,
      { cwd }
    ).catch(() => ({ stdout: '' }));

    const parent = parentHash.trim();

    // Get old file content (from parent commit)
    let oldContent = '';
    if (parent) {
      try {
        const { stdout } = await execAsync(
          `git show ${parent}:${file}`,
          { cwd, maxBuffer: 10 * 1024 * 1024 }
        );
        oldContent = stdout;
      } catch {
        // File does not exist in parent commit (new file)
        oldContent = '';
      }
    }

    // Get new file content (from current commit)
    let newContent = '';
    try {
      const { stdout } = await execAsync(
        `git show ${hash}:${file}`,
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      );
      newContent = stdout;
    } catch {
      // File does not exist in current commit (deleted file)
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
