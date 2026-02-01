import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const COCKPIT_DIR = join(homedir(), '.cockpit');
const PROJECTS_DIR = join(COCKPIT_DIR, 'projects');

// Convert path to directory name (like Claude does: /Users/ka/Work -> -Users-ka-Work)
function pathToDirectoryName(path: string): string {
  return path.replace(/\//g, '-');
}

function getExpandedPathsFile(cwd: string): string {
  const projectDir = join(PROJECTS_DIR, pathToDirectoryName(cwd));
  return join(projectDir, 'expanded-paths.json');
}

async function ensureProjectDir(cwd: string): Promise<void> {
  const projectDir = join(PROJECTS_DIR, pathToDirectoryName(cwd));
  await mkdir(projectDir, { recursive: true });
}

async function readExpandedPaths(cwd: string): Promise<string[]> {
  try {
    const filePath = getExpandedPathsFile(cwd);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeExpandedPaths(cwd: string, paths: string[]): Promise<void> {
  await ensureProjectDir(cwd);
  const filePath = getExpandedPathsFile(cwd);
  await writeFile(filePath, JSON.stringify(paths, null, 2), 'utf-8');
}

// GET - Read expanded paths
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd');

  if (!cwd) {
    return NextResponse.json(
      { error: 'cwd is required' },
      { status: 400 }
    );
  }

  try {
    const paths = await readExpandedPaths(cwd);
    return NextResponse.json({ paths });
  } catch (error) {
    console.error('Error reading expanded paths:', error);
    return NextResponse.json(
      { error: 'Failed to read expanded paths' },
      { status: 500 }
    );
  }
}

// POST - Save expanded paths
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, paths } = body;

    if (!cwd || !Array.isArray(paths)) {
      return NextResponse.json(
        { error: 'cwd and paths array are required' },
        { status: 400 }
      );
    }

    await writeExpandedPaths(cwd, paths);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving expanded paths:', error);
    return NextResponse.json(
      { error: 'Failed to save expanded paths' },
      { status: 500 }
    );
  }
}
