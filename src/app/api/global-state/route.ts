import { NextResponse } from 'next/server';
import { GLOBAL_STATE_FILE, readJsonFile } from '@/lib/paths';
import { updateGlobalState, getLastUserMessage, type SessionStatus } from '@/lib/global-state';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: SessionStatus;
  title?: string;
  lastUserMessage?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

// GET: Retrieve global sessions list
export async function GET() {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
  // Backward compatible: isLoading → status
  for (const s of state.sessions) {
    if (!s.status) {
      const legacy = s as GlobalSession & { isLoading?: boolean };
      s.status = legacy.isLoading ? 'loading' : 'normal';
    }
  }
  // Sort by lastActive descending
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);

  // Keep only the most recent 15 entries
  const recentSessions = state.sessions.slice(0, 15);

  // Fetch last user message for each session (parallel execution)
  const sessionsWithLastMessage = await Promise.all(
    recentSessions.map(async (session) => {
      const lastUserMessage = await getLastUserMessage(session.cwd, session.sessionId);
      return { ...session, lastUserMessage: lastUserMessage ?? session.lastUserMessage };
    })
  );

  return NextResponse.json({ sessions: sessionsWithLastMessage });
}

// POST: Update session status
// body: { cwd: string, sessionId: string, status: SessionStatus, title?: string }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, sessionId, status, title } = body;

  if (!cwd || !sessionId) {
    return NextResponse.json({ error: 'Missing cwd or sessionId' }, { status: 400 });
  }

  await updateGlobalState(cwd, sessionId, status || 'normal', title);

  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  return NextResponse.json(state);
}
