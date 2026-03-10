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
      return NextResponse.json({ hover: null });
    }

    const server = await getOrCreateServer(language, cwd || process.cwd());
    if (!server) {
      return NextResponse.json({ hover: null });
    }

    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      return NextResponse.json({ error: 'Cannot read file' }, { status: 400 });
    }

    const hover = await server.adapter.hover(absPath, line, column);
    return NextResponse.json({ hover });
  } catch (error) {
    console.error('[lsp/hover] error:', error);
    return NextResponse.json({ error: 'LSP hover failed' }, { status: 500 });
  }
}
