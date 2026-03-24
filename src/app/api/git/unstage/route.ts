import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitUnstageRequest {
  cwd?: string;
  files: string[]; // List of file paths, supports single or multiple
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as GitUnstageRequest;
    const { cwd = process.cwd(), files } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid files parameter' }, { status: 400 });
    }

    // Check if this is a git repository
    await execAsync('git rev-parse --git-dir', { cwd });

    // Escape file paths to handle spaces and special characters
    const escapedFiles = files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');

    // Run git restore --staged
    await execAsync(`git restore --staged ${escapedFiles}`, { cwd });

    return NextResponse.json({
      success: true,
      files,
      message: `Unstaged ${files.length} file(s)`,
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.message?.includes('not a git repository')) {
      return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
    }
    console.error('Error unstaging files:', error);
    return NextResponse.json({ error: 'Failed to unstage files' }, { status: 500 });
  }
}
