import { PINNED_SESSIONS_FILE, readJsonFile, writeJsonFile } from '@cockpit/shared-utils';

export interface PinnedSession {
  sessionId: string;
  cwd: string;
  customTitle?: string;
}

export async function GET() {
  try {
    const sessions = await readJsonFile<PinnedSession[]>(PINNED_SESSIONS_FILE, []);
    return Response.json({ sessions });
  } catch {
    return Response.json({ sessions: [] });
  }
}

export async function POST(request: Request) {
  try {
    const { sessions } = await request.json();
    await writeJsonFile(PINNED_SESSIONS_FILE, sessions);
    return Response.json({ success: true });
  } catch (error) {
    console.error('Failed to save pinned sessions:', error);
    return Response.json({ error: 'Failed to save' }, { status: 500 });
  }
}
