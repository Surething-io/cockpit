import { NextRequest } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getTerminalAliasesPath, ensureParentDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET: 获取命令别名
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

    const aliasesFilePath = getTerminalAliasesPath(cwd);

    try {
      const content = await fs.readFile(aliasesFilePath, 'utf-8');
      const aliases = JSON.parse(content);
      return new Response(JSON.stringify({ aliases }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // 文件不存在，返回默认别名
      const defaultAliases = {
        'll': 'ls -la',
        'gs': 'git status',
        'gp': 'git pull',
        'gc': 'git commit',
      };
      return new Response(JSON.stringify({ aliases: defaultAliases }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (error) {
    console.error('Get aliases error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: 保存命令别名
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, aliases } = body;

    if (!cwd || !aliases) {
      return new Response(JSON.stringify({ error: 'Missing cwd or aliases' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const aliasesFilePath = getTerminalAliasesPath(cwd);
    await ensureParentDir(aliasesFilePath);

    // 保存别名
    await fs.writeFile(aliasesFilePath, JSON.stringify(aliases, null, 2), 'utf-8');

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save aliases error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
