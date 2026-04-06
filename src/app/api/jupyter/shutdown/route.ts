import { NextRequest, NextResponse } from 'next/server';
import { kernelManager } from '@/lib/bubbles/jupyter/JupyterKernelManager';

export async function POST(req: NextRequest) {
  try {
    const { bubbleId } = await req.json();

    if (!bubbleId) {
      return NextResponse.json({ error: 'bubbleId is required' }, { status: 400 });
    }

    await kernelManager.shutdown(bubbleId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
