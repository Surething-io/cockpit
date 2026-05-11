import { getStatus } from '@cockpit/feature-explorer/server/lsp/LSPServerRegistry';

export async function GET() {
  try {
    const servers = getStatus();
    return Response.json({ servers });
  } catch (error) {
    console.error('[lsp/status] error:', error);
    return Response.json({ error: 'Failed to get LSP status' }, { status: 500 });
  }
}
