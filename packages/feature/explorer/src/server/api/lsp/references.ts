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
      return Response.json({ references: [] });
    }

    const server = await getOrCreateServer(language, cwd || process.cwd());
    if (!server) {
      return Response.json({ references: [] });
    }

    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      return Response.json({ error: 'Cannot read file' }, { status: 400 });
    }

    const references = await server.adapter.references(absPath, line, column);
    return Response.json({ references });
  } catch (error) {
    console.error('[lsp/references] error:', error);
    return Response.json({ error: 'LSP references failed' }, { status: 500 });
  }
}
