import { NextRequest } from 'next/server';
import { getProjectSettingsPath, readJsonFile, writeJsonFile } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProjectSettings {
  gridLayout?: boolean;
  usePty?: boolean;
  activeView?: 'agent' | 'explorer' | 'console';
}

const DEFAULT_SETTINGS: ProjectSettings = {
  gridLayout: true,
  usePty: false,
};

// GET: 获取项目设置
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');

    if (!cwd) {
      return new Response(JSON.stringify({ error: 'Missing cwd parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const settingsPath = getProjectSettingsPath(cwd);
    const settings = await readJsonFile<ProjectSettings>(settingsPath, DEFAULT_SETTINGS);

    return new Response(JSON.stringify({ settings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Get project settings error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: 保存项目设置（增量合并）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, settings } = body;

    if (!cwd || !settings) {
      return new Response(JSON.stringify({ error: 'Missing cwd or settings' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const settingsPath = getProjectSettingsPath(cwd);
    const existing = await readJsonFile<ProjectSettings>(settingsPath, DEFAULT_SETTINGS);
    const merged = { ...existing, ...settings };

    await writeJsonFile(settingsPath, merged);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save project settings error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
