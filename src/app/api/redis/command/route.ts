import { NextRequest, NextResponse } from 'next/server';
import { redisManager } from '@/lib/bubbles/redis/RedisManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, command, args = [] } = await req.json();
    if (!id || !connectionString || !command) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const start = performance.now();
    const result = await client.call(command, ...args);
    const duration = Math.round((performance.now() - start) * 100) / 100;

    return NextResponse.json({ result, duration });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
