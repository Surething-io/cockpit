import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { getLanguageForFile } from '@cockpit/feature-explorer/server/lsp/types';
import { getOrCreateServer, ensureFileOpen } from '@cockpit/feature-explorer/server/lsp/LSPServerRegistry';

/**
 * Warm up LSP: start the Language Server for the given language and open the file
 * Called by the frontend when a TS/JS/PY file is selected; does not block the UI
 */
export async function POST(request: Request) {
  try {
    const { cwd, filePath } = await request.json();
    if (!filePath) {
      return Response.json({ ok: false });
    }

    const language = getLanguageForFile(filePath);
    if (!language) {
      return Response.json({ ok: false });
    }

    const server = await getOrCreateServer(language, cwd || process.cwd());
    if (!server) {
      return Response.json({ ok: false });
    }

    // Pre-open the file so subsequent hover/definition requests don't need to wait for open
    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      // File is not readable, ignore
    }

    return Response.json({ ok: true, language, pid: server.process.pid });
  } catch (error) {
    console.error('[lsp/warmup] error:', error);
    return Response.json({ ok: false });
  }
}
