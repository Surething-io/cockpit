import { redisManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString, command, args = [] } = await req.json();
    if (!id || !connectionString || !command) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const client = await redisManager.getClient(id, connectionString);
    const start = performance.now();
    const result = await client.call(command, ...args);
    const duration = Math.round((performance.now() - start) * 100) / 100;

    return Response.json({ result, duration });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
