import { NextRequest } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getTerminalEnvPath, ensureParentDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET: Fetch environment variables
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');
    const tabId = searchParams.get('tabId');

    if (!cwd) {
      return new Response(JSON.stringify({ error: 'Missing cwd parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const envFilePath = getTerminalEnvPath(cwd, tabId || undefined);

    try {
      const content = await fs.readFile(envFilePath, 'utf-8');
      const env = JSON.parse(content);
      return new Response(JSON.stringify({ env }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // File does not exist, return empty object
      return new Response(JSON.stringify({ env: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (error) {
    console.error('Get env error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: Save environment variables
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, tabId, env } = body;

    if (!cwd || !env) {
      return new Response(JSON.stringify({ error: 'Missing cwd or env' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const envFilePath = getTerminalEnvPath(cwd, tabId);
    await ensureParentDir(envFilePath);

    // Save environment variables
    await fs.writeFile(envFilePath, JSON.stringify(env, null, 2), 'utf-8');

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save env error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
