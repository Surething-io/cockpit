import { NextResponse } from 'next/server';
import { getStatus } from '@/lib/lsp/LSPServerRegistry';

export async function GET() {
  try {
    const servers = getStatus();
    return NextResponse.json({ servers });
  } catch (error) {
    console.error('[lsp/status] error:', error);
    return NextResponse.json({ error: 'Failed to get LSP status' }, { status: 500 });
  }
}
