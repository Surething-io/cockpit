import { NextRequest, NextResponse } from 'next/server';
import { redisManager } from '@/lib/bubbles/redis/RedisManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, key, value, type, field, ttl } = await req.json();
    if (!id || !connectionString || key === undefined) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);

    switch (type) {
      case 'string':
        await client.set(key, value);
        break;
      case 'hash':
        if (field !== undefined) {
          await client.hset(key, field, value);
        }
        break;
      case 'list':
        // Direct modification not supported; use CLI
        break;
      case 'set':
        // Direct modification not supported; use CLI
        break;
      case 'zset':
        // Direct modification not supported; use CLI
        break;
      default:
        await client.set(key, value);
    }

    // Set TTL if provided
    if (ttl !== undefined && ttl > 0) {
      await client.expire(key, ttl);
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
