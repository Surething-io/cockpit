import { NextRequest, NextResponse } from 'next/server';
import { getExpandedPathsPath, readJsonFile, writeJsonFile } from '@/lib/paths';

// GET - Read expanded paths
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get('cwd');

  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const filePath = getExpandedPathsPath(cwd);
    const paths = await readJsonFile<string[]>(filePath, []);
    return NextResponse.json({ paths });
  } catch (error) {
    console.error('Error reading expanded paths:', error);
    return NextResponse.json({ error: 'Failed to read expanded paths' }, { status: 500 });
  }
}

// POST - Save expanded paths
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, paths } = body;

    if (!cwd || !Array.isArray(paths)) {
      return NextResponse.json({ error: 'cwd and paths array are required' }, { status: 400 });
    }

    const filePath = getExpandedPathsPath(cwd);
    await writeJsonFile(filePath, paths);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving expanded paths:', error);
    return NextResponse.json({ error: 'Failed to save expanded paths' }, { status: 500 });
  }
}
