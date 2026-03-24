import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export interface GitDiffResponse {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const file = searchParams.get('file');
  const type = searchParams.get('type') as 'staged' | 'unstaged';

  if (!file) {
    return NextResponse.json({ error: 'Missing file parameter' }, { status: 400 });
  }

  if (!type || !['staged', 'unstaged'].includes(type)) {
    return NextResponse.json({ error: 'Invalid type parameter. Must be "staged" or "unstaged"' }, { status: 400 });
  }

  try {
    const absolutePath = path.resolve(cwd, file);
    let oldContent = '';
    let newContent = '';
    let isNew = false;
    let isDeleted = false;

    if (type === 'staged') {
      // Staging area: HEAD vs staging area
      // Get HEAD version
      try {
        const { stdout: headContent } = await execAsync(`git show HEAD:"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
        oldContent = headContent;
      } catch {
        // File is newly added, does not exist in HEAD
        isNew = true;
        oldContent = '';
      }

      // Get staging area version
      try {
        const { stdout: stagedContent } = await execAsync(`git show :"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
        newContent = stagedContent;
      } catch {
        // File was deleted
        isDeleted = true;
        newContent = '';
      }
    } else {
      // Working tree: staging area vs working tree (or HEAD vs working tree if nothing staged)
      // Try to get staging area version first
      try {
        const { stdout: stagedContent } = await execAsync(`git show :"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
        oldContent = stagedContent;
      } catch {
        // Nothing in staging area, try HEAD version
        try {
          const { stdout: headContent } = await execAsync(`git show HEAD:"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
          oldContent = headContent;
        } catch {
          // Neither exists, this is a new file
          isNew = true;
          oldContent = '';
        }
      }

      // Get working tree version (current file content)
      try {
        newContent = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // File was deleted
        isDeleted = true;
        newContent = '';
      }
    }

    return NextResponse.json({
      oldContent,
      newContent,
      filePath: file,
      isNew,
      isDeleted,
    } as GitDiffResponse);
  } catch (error) {
    console.error('Error getting git diff:', error);
    return NextResponse.json({ error: 'Failed to get git diff' }, { status: 500 });
  }
}
