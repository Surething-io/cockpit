import { NextRequest } from 'next/server';
import { getBubbleOrderPath, readJsonFile, writeJsonFile } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET: Fetch bubble order
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');
    const tabId = searchParams.get('tabId');

    if (!cwd || !tabId) {
      return new Response(JSON.stringify({ error: 'Missing cwd or tabId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const orderPath = getBubbleOrderPath(cwd, tabId);
    const order = await readJsonFile<string[]>(orderPath, []);

    return new Response(JSON.stringify({ order }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Get bubble order error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: Save bubble order
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, tabId, order } = body;

    if (!cwd || !tabId || !Array.isArray(order)) {
      return new Response(JSON.stringify({ error: 'Missing cwd, tabId or order' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const orderPath = getBubbleOrderPath(cwd, tabId);
    await writeJsonFile(orderPath, order);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save bubble order error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
