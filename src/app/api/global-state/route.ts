import { NextResponse } from 'next/server';
import { GLOBAL_STATE_FILE, readJsonFile } from '@/lib/paths';
import { updateGlobalState, getLastUserMessage } from '@/lib/global-state';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
  lastUserMessage?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

// GET: 获取全局 sessions 列表
export async function GET() {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
  // 按 lastActive 降序排序
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);

  // 只保留最近 15 条
  const recentSessions = state.sessions.slice(0, 15);

  // 为每个 session 获取最后一条用户消息（并行执行）
  const sessionsWithLastMessage = await Promise.all(
    recentSessions.map(async (session) => {
      const lastUserMessage = await getLastUserMessage(session.cwd, session.sessionId);
      return { ...session, lastUserMessage };
    })
  );

  return NextResponse.json({ sessions: sessionsWithLastMessage });
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
