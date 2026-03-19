import { NextRequest, NextResponse } from 'next/server';
import { redisManager } from '@/lib/bubbles/redis/RedisManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString } = await req.json();
    if (!id || !connectionString) {
      return NextResponse.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const info = await client.info();

    const version = info.match(/redis_version:(.+)/)?.[1]?.trim() || 'unknown';
    const mode = info.match(/redis_mode:(.+)/)?.[1]?.trim() || 'standalone';
    const memory = info.match(/used_memory_human:(.+)/)?.[1]?.trim() || '0B';
    const dbSize = await client.dbsize();

    return NextResponse.json({ version, mode, dbSize, memory });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
