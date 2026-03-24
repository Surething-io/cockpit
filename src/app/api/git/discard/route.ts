import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// POST - Discard changes
// body: { cwd, files: string[], isUntracked?: boolean }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, files, isUntracked } = body;

    if (!cwd || !files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json(
        { error: 'cwd and files are required' },
        { status: 400 }
      );
    }

    const results: { file: string; success: boolean; error?: string }[] = [];

    for (const file of files) {
      try {
        if (isUntracked) {
          // Delete untracked file
          const filePath = path.join(cwd, file);
          await fs.unlink(filePath);
          results.push({ file, success: true });
        } else {
          // git restore tracked file
          await execAsync(`git restore "${file}"`, { cwd });
          results.push({ file, success: true });
        }
      } catch (err) {
        results.push({
          file,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error('Error discarding changes:', error);
    return NextResponse.json(
      { error: 'Failed to discard changes' },
      { status: 500 }
    );
  }
}
