import { NextRequest, NextResponse } from 'next/server';
import { redisManager } from '@/lib/bubbles/redis/RedisManager';

const MAX_ITEMS = 500;

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, key } = await req.json();
    if (!id || !connectionString || key === undefined) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);

    const [type, ttl, size] = await Promise.all([
      client.type(key),
      client.ttl(key),
      client.call('MEMORY', 'USAGE', key).catch(() => null) as Promise<number | null>,
    ]);

    let value: unknown;
    switch (type) {
      case 'string':
        value = await client.get(key);
        break;
      case 'hash':
        value = await client.hgetall(key);
        break;
      case 'list': {
        const len = await client.llen(key);
        const items = await client.lrange(key, 0, Math.min(len, MAX_ITEMS) - 1);
        value = { items, total: len };
        break;
      }
      case 'set': {
        const card = await client.scard(key);
        const members = await client.srandmember(key, Math.min(card, MAX_ITEMS));
        value = { items: members || [], total: card };
        break;
      }
      case 'zset': {
        const len = await client.zcard(key);
        const raw = await client.zrange(key, 0, Math.min(len, MAX_ITEMS) - 1, 'WITHSCORES');
        const pairs: { member: string; score: string }[] = [];
        for (let i = 0; i < raw.length; i += 2) {
          pairs.push({ member: raw[i], score: raw[i + 1] });
        }
        value = { items: pairs, total: len };
        break;
      }
      case 'stream': {
        const len = await client.xlen(key);
        const entries = await client.xrange(key, '-', '+', 'COUNT', MAX_ITEMS);
        value = { entries, total: len };
        break;
      }
      default:
        value = null;
    }

    return NextResponse.json({ type, value, ttl, size });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
