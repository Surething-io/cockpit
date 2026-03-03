import { NextResponse } from 'next/server';
import { PINNED_SESSIONS_FILE, readJsonFile, writeJsonFile } from '@/lib/paths';

export interface PinnedSession {
  sessionId: string;
  cwd: string;
  customTitle?: string;
}

export async function GET() {
  try {
    const sessions = await readJsonFile<PinnedSession[]>(PINNED_SESSIONS_FILE, []);
    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}

export async function POST(request: Request) {
  try {
    const { sessions } = await request.json();
    await writeJsonFile(PINNED_SESSIONS_FILE, sessions);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to save pinned sessions:', error);
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
