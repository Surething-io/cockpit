import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { getLanguageForFile } from '@cockpit/feature-explorer/server/lsp/types';
import { getOrCreateServer, ensureFileOpen } from '@cockpit/feature-explorer/server/lsp/LSPServerRegistry';

export async function POST(request: Request) {
  try {
    const { cwd, filePath, line, column } = await request.json();

    if (!filePath || !line || !column) {
      return Response.json({ error: 'Missing filePath, line, or column' }, { status: 400 });
    }

    const language = getLanguageForFile(filePath);
    if (!language) {
      return Response.json({ definitions: [] });
    }

    const server = await getOrCreateServer(language, cwd || process.cwd());
    if (!server) {
      return Response.json({ definitions: [] });
    }

    // Ensure the file is open
    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      return Response.json({ error: 'Cannot read file' }, { status: 400 });
    }

    const definitions = await server.adapter.definition(absPath, line, column);
    return Response.json({ definitions });
  } catch (error) {
    console.error('[lsp/definition] error:', error);
    return Response.json({ error: 'LSP definition failed' }, { status: 500 });
  }
}
