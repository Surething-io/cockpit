import { NextRequest } from 'next/server';
import * as fs from 'fs/promises';
import { getGlobalAliasesPath, ensureParentDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_ALIASES: Record<string, string> = {
  'll': 'ls -la',
  'gs': 'git status',
  'gp': 'git pull',
  'gc': 'git commit',
};

// GET: 获取全局命令别名
export async function GET() {
  try {
    const aliasesFilePath = getGlobalAliasesPath();

    try {
      const content = await fs.readFile(aliasesFilePath, 'utf-8');
      const aliases = JSON.parse(content);
      return new Response(JSON.stringify({ aliases }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // 文件不存在，返回默认别名
      return new Response(JSON.stringify({ aliases: DEFAULT_ALIASES }), {
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

// POST: 保存全局命令别名
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { aliases } = body;

    if (!aliases) {
      return new Response(JSON.stringify({ error: 'Missing aliases' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const aliasesFilePath = getGlobalAliasesPath();
    await ensureParentDir(aliasesFilePath);
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
