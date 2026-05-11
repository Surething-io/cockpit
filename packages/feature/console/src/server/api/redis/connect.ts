import { redisManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString } = await req.json();
    if (!id || !connectionString) {
      return Response.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const info = await client.info();

    const version = info.match(/redis_version:(.+)/)?.[1]?.trim() || 'unknown';
    const mode = info.match(/redis_mode:(.+)/)?.[1]?.trim() || 'standalone';
    const memory = info.match(/used_memory_human:(.+)/)?.[1]?.trim() || '0B';
    const dbSize = await client.dbsize();

    return Response.json({ version, mode, dbSize, memory });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
