import { NextResponse } from 'next/server';
import { getBrowserTabsPath, readJsonFile, writeJsonFile } from '@/lib/paths';

export interface BrowserTab {
  id: string;
  url: string;
}

interface BrowserTabsState {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

const DEFAULT_STATE: BrowserTabsState = {
  tabs: [],
  activeTabId: null,
};

// GET: 读取项目的 browser tabs
// ?cwd=/path/to/project
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cwd = searchParams.get('cwd');

  if (!cwd) {
    return NextResponse.json({ error: 'Missing cwd parameter' }, { status: 400 });
  }

  const filePath = getBrowserTabsPath(cwd);
  const state = await readJsonFile<BrowserTabsState>(filePath, DEFAULT_STATE);
  return NextResponse.json(state);
}

// POST: 更新项目的 browser tabs
// body: { cwd: string, tabs: BrowserTab[], activeTabId: string | null }
export async function POST(request: Request) {
  const body = await request.json();
  const { cwd, tabs, activeTabId } = body;

  if (!cwd) {
    return NextResponse.json({ error: 'Missing cwd parameter' }, { status: 400 });
  }

  if (!Array.isArray(tabs)) {
    return NextResponse.json({ error: 'tabs must be an array' }, { status: 400 });
  }

  const state: BrowserTabsState = { tabs, activeTabId };
  const filePath = getBrowserTabsPath(cwd);
  await writeJsonFile(filePath, state);
  return NextResponse.json(state);
}
