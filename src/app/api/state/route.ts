import { NextResponse } from 'next/server';
import { getSessionFilePath, readJsonFile, writeJsonFile } from '@/lib/paths';

interface ProjectState {
  sessions: string[];
}

// GET: 读取项目的 sessions 列表
// ?cwd=/path/to/project
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cwd = searchParams.get('cwd');

  if (!cwd) {
    return NextResponse.json({ error: 'Missing cwd parameter' }, { status: 400 });
  }

  const filePath = getSessionFilePath(cwd);
  const state = await readJsonFile<ProjectState>(filePath, { sessions: [] });
  return NextResponse.json(state);
}

// POST: 更新项目的 sessions 列表
// body: { cwd: string, sessions: string[] }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, sessions } = body;

  if (!cwd) {
    return NextResponse.json({ error: 'Missing cwd parameter' }, { status: 400 });
  }

  if (!Array.isArray(sessions)) {
    return NextResponse.json({ error: 'sessions must be an array' }, { status: 400 });
  }

  const state: ProjectState = { sessions };
  const filePath = getSessionFilePath(cwd);
  await writeJsonFile(filePath, state);
  return NextResponse.json(state);
}
