import { NextResponse } from 'next/server';
import { getSessionFilePath, readJsonFile, writeJsonFile } from '@/lib/paths';

interface ProjectState {
  sessions: string[];
  activeSessionId?: string; // sessionId of the currently active tab
  engines?: Record<string, string>; // sessionId → engine ('claude' | 'codex' | 'ollama')
  ollamaModels?: Record<string, string>; // sessionId → ollama model name
}

// GET: Read the project's session list
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

// POST: Update the project's session list and the active sessionId
// body: { cwd: string, sessions: string[], activeSessionId?: string }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, sessions, activeSessionId, engines, ollamaModels } = body;

  if (!cwd) {
    return NextResponse.json({ error: 'Missing cwd parameter' }, { status: 400 });
  }

  if (!Array.isArray(sessions)) {
    return NextResponse.json({ error: 'sessions must be an array' }, { status: 400 });
  }

  const state: ProjectState = { sessions, activeSessionId, ...(engines && { engines }), ...(ollamaModels && { ollamaModels }) };
  const filePath = getSessionFilePath(cwd);
  await writeJsonFile(filePath, state);
  return NextResponse.json(state);
}
