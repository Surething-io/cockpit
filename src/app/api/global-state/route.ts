import { NextResponse } from 'next/server';
import { GLOBAL_STATE_FILE, readJsonFile, writeJsonFile } from '@/lib/paths';

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

const MAX_SESSIONS = 10;

// GET: 获取全局 sessions 列表
export async function GET() {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
  // 按 lastActive 降序排序
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  return NextResponse.json(state);
}

// POST: 更新 session 状态
// body: { cwd: string, sessionId: string, isLoading: boolean }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, sessionId, isLoading, title } = body;

  if (!cwd || !sessionId) {
    return NextResponse.json({ error: 'Missing cwd or sessionId' }, { status: 400 });
  }

  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

  // 查找是否已存在
  const existingIndex = state.sessions.findIndex(
    s => s.cwd === cwd && s.sessionId === sessionId
  );

  // 保留现有 title（如果没有传入新的）
  const existingTitle = existingIndex >= 0 ? state.sessions[existingIndex].title : undefined;

  const newSession: GlobalSession = {
    cwd,
    sessionId,
    lastActive: Date.now(),
    isLoading: Boolean(isLoading),
    title: title || existingTitle,
  };

  if (existingIndex >= 0) {
    // 更新已存在的
    state.sessions[existingIndex] = newSession;
  } else {
    // 添加新的
    state.sessions.push(newSession);
  }

  // 按 lastActive 降序排序
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);

  // 只保留最近 10 个
  state.sessions = state.sessions.slice(0, MAX_SESSIONS);

  await writeJsonFile(GLOBAL_STATE_FILE, state);
  return NextResponse.json(state);
}
