import { redisManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) {
      return Response.json({ error: 'Missing id' }, { status: 400 });
    }
    await redisManager.disconnect(id);
    return Response.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
