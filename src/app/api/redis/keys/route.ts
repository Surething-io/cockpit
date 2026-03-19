import { NextRequest, NextResponse } from 'next/server';
import { redisManager } from '@/lib/bubbles/redis/RedisManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, pattern = '*', cursor = '0', count = 100 } = await req.json();
    if (!id || !connectionString) {
      return NextResponse.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);

    // Batch TYPE lookups via pipeline
    if (keys.length === 0) {
      return NextResponse.json({ keys: [], cursor: nextCursor, hasMore: nextCursor !== '0' });
    }

    const pipeline = client.pipeline();
    for (const key of keys) {
      pipeline.type(key);
    }
    const types = await pipeline.exec();

    const keyList = keys.map((key, i) => ({
      key,
      type: (types?.[i]?.[1] as string) || 'unknown',
    }));

    return NextResponse.json({
      keys: keyList,
      cursor: nextCursor,
      hasMore: nextCursor !== '0',
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
