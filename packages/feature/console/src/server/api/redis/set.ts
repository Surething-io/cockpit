import { redisManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString, key, value, type, field, ttl } = await req.json();
    if (!id || !connectionString || key === undefined) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
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

    return Response.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
