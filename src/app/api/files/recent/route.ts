import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const COCKPIT_DIR = join(homedir(), '.cockpit');
const PROJECTS_DIR = join(COCKPIT_DIR, 'projects');
const MAX_RECENT_FILES = 15;

// Convert path to directory name (like Claude does: /Users/ka/Work -> -Users-ka-Work)
function pathToDirectoryName(path: string): string {
  return path.replace(/\//g, '-');
}

function getRecentFilesPath(cwd: string): string {
  const projectDir = join(PROJECTS_DIR, pathToDirectoryName(cwd));
  return join(projectDir, 'recent-files.json');
}

async function ensureProjectDir(cwd: string): Promise<void> {
  const projectDir = join(PROJECTS_DIR, pathToDirectoryName(cwd));
  await mkdir(projectDir, { recursive: true });
}

async function readRecentFiles(cwd: string): Promise<string[]> {
  try {
    const filePath = getRecentFilesPath(cwd);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeRecentFiles(cwd: string, files: string[]): Promise<void> {
  await ensureProjectDir(cwd);
  const filePath = getRecentFilesPath(cwd);
  await writeFile(filePath, JSON.stringify(files, null, 2), 'utf-8');
}

// GET - Read recent files
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
    const files = await readRecentFiles(cwd);
    return NextResponse.json({ files });
  } catch (error) {
    console.error('Error reading recent files:', error);
    return NextResponse.json(
      { error: 'Failed to read recent files' },
      { status: 500 }
    );
  }
}

// POST - Add a file to recent files
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, file } = body;

    if (!cwd || !file) {
      return NextResponse.json(
        { error: 'cwd and file are required' },
        { status: 400 }
      );
    }

    // Read current recent files
    let files = await readRecentFiles(cwd);

    // Remove the file if it already exists (to move it to the top)
    files = files.filter(f => f !== file);

    // Add to the beginning
    files.unshift(file);

    // Keep only the last N files
    files = files.slice(0, MAX_RECENT_FILES);

    // Write back
    await writeRecentFiles(cwd, files);

    return NextResponse.json({ files });
  } catch (error) {
    console.error('Error adding recent file:', error);
    return NextResponse.json(
      { error: 'Failed to add recent file' },
      { status: 500 }
    );
  }
}
