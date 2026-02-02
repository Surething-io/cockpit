import { NextResponse } from 'next/server';
import { getSessionFilePath, readJsonFile, writeJsonFile } from '@/lib/paths';

interface ProjectState {
  sessions: string[];
  activeSessionId?: string; // 当前激活的 Tab 对应的 sessionId
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

// POST: 更新项目的 sessions 列表和激活的 sessionId
// body: { cwd: string, sessions: string[], activeSessionId?: string }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, sessions, activeSessionId } = body;

  if (!cwd) {
    return NextResponse.json({ error: 'Missing cwd parameter' }, { status: 400 });
  }

  if (!Array.isArray(sessions)) {
    return NextResponse.json({ error: 'sessions must be an array' }, { status: 400 });
  }

  const state: ProjectState = { sessions, activeSessionId };
  const filePath = getSessionFilePath(cwd);
  await writeJsonFile(filePath, state);
  return NextResponse.json(state);
}
