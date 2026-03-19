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
        // 不支持直接修改，通过 CLI
        break;
      case 'set':
        // 不支持直接修改，通过 CLI
        break;
      case 'zset':
        // 不支持直接修改，通过 CLI
        break;
      default:
        await client.set(key, value);
    }

    // 设置 TTL（如果提供）
    if (ttl !== undefined && ttl > 0) {
      await client.expire(key, ttl);
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
