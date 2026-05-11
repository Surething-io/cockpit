import { redisManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString, pattern = '*', cursor = '0', count = 100 } = await req.json();
    if (!id || !connectionString) {
      return Response.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);

    // Batch TYPE lookups via pipeline
    if (keys.length === 0) {
      return Response.json({ keys: [], cursor: nextCursor, hasMore: nextCursor !== '0' });
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

    return Response.json({
      keys: keyList,
      cursor: nextCursor,
      hasMore: nextCursor !== '0',
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
