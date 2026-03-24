import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Maximum allowed runtime for git blame/log to prevent large repos from blocking the event loop */
const GIT_TIMEOUT_MS = 15000;

/** Maximum number of concurrent git blame processes to prevent subprocess buildup when multiple files are opened */
const MAX_CONCURRENT = 3;
let activeCount = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      waitQueue.push(() => { activeCount++; resolve(); });
    }
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}

interface BlameLine {
  hash: string;
  hashFull: string;
  author: string;
  authorEmail: string;
  time: number; // Unix timestamp
  message: string; // Full commit message
  line: number;
  content: string;
}

interface CommitInfo {
  author: string;
  authorEmail: string;
  time: number;
  message: string;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd');
  const path = searchParams.get('path');

  if (!cwd || !path) {
    return NextResponse.json(
      { error: 'cwd and path are required' },
      { status: 400 }
    );
  }

  await acquireSlot();
  try {
    // Use git blame with porcelain format for easy parsing
    // -c core.quotePath=false prevents Chinese filenames from being escaped as octal
    const { stdout } = await execAsync(
      `git -c core.quotePath=false blame --porcelain "${path}"`,
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }
    );

    const lines = stdout.split('\n');

    // First pass: collect unique commit hashes and basic info
    const commitInfoMap = new Map<string, CommitInfo>();
    let currentHashFull = '';
    let currentAuthor = '';
    let currentAuthorEmail = '';
    let currentTime = 0;

    for (const line of lines) {
      if (/^[0-9a-f]{40}/.test(line)) {
        const parts = line.split(' ');
        currentHashFull = parts[0];
      } else if (line.startsWith('author ')) {
        currentAuthor = line.substring(7);
      } else if (line.startsWith('author-mail ')) {
        const match = line.substring(12).match(/<(.+)>/);
        currentAuthorEmail = match ? match[1] : line.substring(12);
      } else if (line.startsWith('author-time ')) {
        currentTime = parseInt(line.substring(12), 10);
      } else if (line.startsWith('\t') && currentHashFull && !commitInfoMap.has(currentHashFull)) {
        commitInfoMap.set(currentHashFull, {
          author: currentAuthor,
          authorEmail: currentAuthorEmail,
          time: currentTime,
          message: '', // Will be filled later
        });
      }
    }

    // Get full commit messages for all unique commits
    // Filter out all-zero hash (uncommitted changes) — git log cannot handle it
    const ZERO_HASH = '0000000000000000000000000000000000000000';
    const uncommittedInfo = commitInfoMap.get(ZERO_HASH);
    if (uncommittedInfo) {
      uncommittedInfo.message = 'Not Committed Yet';
    }
    const uniqueHashes = Array.from(commitInfoMap.keys()).filter(h => h !== ZERO_HASH);
    if (uniqueHashes.length > 0) {
      // Use git log to get full messages for all commits at once
      // Format: hash<NUL>message<NUL>hash<NUL>message...
      const { stdout: logOutput } = await execAsync(
        `git -c core.quotePath=false log --format="%H%x00%B%x00" --no-walk ${uniqueHashes.join(' ')}`,
        { cwd, maxBuffer: 10 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }
      );

      // Parse the log output
      const logParts = logOutput.split('\0').filter(Boolean);
      for (let i = 0; i < logParts.length; i += 2) {
        const hash = logParts[i]?.trim();
        const message = logParts[i + 1]?.trim() || '';
        if (hash && commitInfoMap.has(hash)) {
          const info = commitInfoMap.get(hash)!;
          info.message = message;
        }
      }
    }

    // Second pass: build blame lines with full commit info
    const blameLines: BlameLine[] = [];
    currentHashFull = '';
    let lineNumber = 0;

    for (const line of lines) {
      if (/^[0-9a-f]{40}/.test(line)) {
        const parts = line.split(' ');
        currentHashFull = parts[0];
        lineNumber = parseInt(parts[2], 10);
      } else if (line.startsWith('\t')) {
        const info = commitInfoMap.get(currentHashFull);
        if (info) {
          blameLines.push({
            hash: currentHashFull.substring(0, 7),
            hashFull: currentHashFull,
            author: info.author,
            authorEmail: info.authorEmail,
            time: info.time,
            message: info.message,
            line: lineNumber,
            content: line.substring(1),
          });
        }
      }
    }

    return NextResponse.json({ blame: blameLines });
  } catch (error) {
    console.error('Error getting blame:', error);
    return NextResponse.json(
      { error: 'Failed to get blame info. File may not be tracked by git.' },
      { status: 500 }
    );
  } finally {
    releaseSlot();
  }
}
