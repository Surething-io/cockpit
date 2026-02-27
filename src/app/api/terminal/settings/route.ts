import { NextRequest } from 'next/server';
import { getTerminalSettingsPath, readJsonFile, writeJsonFile } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TerminalSettings {
  gridLayout?: boolean;
  usePty?: boolean;
}

const DEFAULT_SETTINGS: TerminalSettings = {
  gridLayout: false,
  usePty: false,
};

// GET: 获取 terminal 设置
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

    const settingsPath = getTerminalSettingsPath(cwd);
    const settings = await readJsonFile<TerminalSettings>(settingsPath, DEFAULT_SETTINGS);

    return new Response(JSON.stringify({ settings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Get terminal settings error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: 保存 terminal 设置（增量合并）
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

    const settingsPath = getTerminalSettingsPath(cwd);
    const existing = await readJsonFile<TerminalSettings>(settingsPath, DEFAULT_SETTINGS);
    const merged = { ...existing, ...settings };

    await writeJsonFile(settingsPath, merged);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save terminal settings error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
