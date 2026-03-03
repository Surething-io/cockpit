import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { getLanguageForFile } from '@/lib/lsp/types';
import { getOrCreateServer, ensureFileOpen } from '@/lib/lsp/LSPServerRegistry';

export async function POST(request: NextRequest) {
  try {
    const { cwd, filePath, line, column } = await request.json();

    if (!filePath || !line || !column) {
      return NextResponse.json({ error: 'Missing filePath, line, or column' }, { status: 400 });
    }

    const language = getLanguageForFile(filePath);
    if (!language) {
      return NextResponse.json({ references: [] });
    }

    const server = await getOrCreateServer(language);
    if (!server) {
      return NextResponse.json({ references: [] });
    }

    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      return NextResponse.json({ error: 'Cannot read file' }, { status: 400 });
    }

    const references = await server.adapter.references(absPath, line, column);
    return NextResponse.json({ references });
  } catch (error) {
    console.error('[lsp/references] error:', error);
    return NextResponse.json({ error: 'LSP references failed' }, { status: 500 });
  }
}
