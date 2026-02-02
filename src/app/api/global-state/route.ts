import { NextResponse } from 'next/server';
import { GLOBAL_STATE_FILE, readJsonFile } from '@/lib/paths';
import { updateGlobalState } from '@/lib/global-state';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

// GET: 获取全局 sessions 列表
export async function GET() {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
  // 按 lastActive 降序排序
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  return NextResponse.json(state);
}

// POST: 更新 session 状态
// body: { cwd: string, sessionId: string, isLoading: boolean, title?: string }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, sessionId, isLoading, title } = body;

  if (!cwd || !sessionId) {
    return NextResponse.json({ error: 'Missing cwd or sessionId' }, { status: 400 });
  }

  await updateGlobalState(cwd, sessionId, Boolean(isLoading), title);

  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  return NextResponse.json(state);
}
