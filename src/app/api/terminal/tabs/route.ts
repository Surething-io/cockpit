import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getTerminalTabsPath, ensureParentDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
}

interface TerminalTabsData {
  tabs: TerminalTab[];
  activeTabId: string;
}

// GET: 读取 terminal tabs
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

    const storagePath = getTerminalTabsPath(cwd);

    try {
      const data = await fs.readFile(storagePath, 'utf-8');
      const parsed: TerminalTabsData = JSON.parse(data);
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error: any) {
      // 文件不存在或读取失败，返回 null
      if (error.code === 'ENOENT') {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Get terminal tabs error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: 保存 terminal tabs
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, tabs, activeTabId } = body;

    if (!cwd || !tabs || !Array.isArray(tabs)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const storagePath = getTerminalTabsPath(cwd);
    await ensureParentDir(storagePath);

    const data: TerminalTabsData = {
      tabs,
      activeTabId,
    };

    await fs.writeFile(storagePath, JSON.stringify(data, null, 2), 'utf-8');

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save terminal tabs error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
