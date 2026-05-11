import { kernelManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { bubbleId } = await req.json();

    if (!bubbleId) {
      return Response.json({ error: 'bubbleId is required' }, { status: 400 });
    }

    await kernelManager.shutdown(bubbleId);
    return Response.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: msg }, { status: 500 });
  }
}
