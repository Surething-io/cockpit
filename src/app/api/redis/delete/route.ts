import { NextRequest, NextResponse } from 'next/server';
import { redisManager } from '@/lib/bubbles/redis/RedisManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, keys } = await req.json();
    if (!id || !connectionString || !Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const deleted = await client.del(...keys);

    return NextResponse.json({ deleted });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
