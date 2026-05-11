import { redisManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString, keys } = await req.json();
    if (!id || !connectionString || !Array.isArray(keys) || keys.length === 0) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const deleted = await client.del(...keys);

    return Response.json({ deleted });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
