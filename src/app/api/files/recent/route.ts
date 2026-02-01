import { NextRequest, NextResponse } from 'next/server';
import { getRecentFilesPath, readJsonFile, writeJsonFile } from '@/lib/paths';

const MAX_RECENT_FILES = 15;

// GET - Read recent files
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get('cwd');

  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const filePath = getRecentFilesPath(cwd);
    const files = await readJsonFile<string[]>(filePath, []);
    return NextResponse.json({ files });
  } catch (error) {
    console.error('Error reading recent files:', error);
    return NextResponse.json({ error: 'Failed to read recent files' }, { status: 500 });
  }
}

// POST - Add a file to recent files
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, file } = body;

    if (!cwd || !file) {
      return NextResponse.json({ error: 'cwd and file are required' }, { status: 400 });
    }

    const filePath = getRecentFilesPath(cwd);

    // Read current recent files
    let files = await readJsonFile<string[]>(filePath, []);

    // Remove the file if it already exists (to move it to the top)
    files = files.filter(f => f !== file);

    // Add to the beginning
    files.unshift(file);

    // Keep only the last N files
    files = files.slice(0, MAX_RECENT_FILES);

    // Write back
    await writeJsonFile(filePath, files);

    return NextResponse.json({ files });
  } catch (error) {
    console.error('Error adding recent file:', error);
    return NextResponse.json({ error: 'Failed to add recent file' }, { status: 500 });
  }
}
