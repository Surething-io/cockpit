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
      return NextResponse.json({ definitions: [] });
    }

    const server = await getOrCreateServer(language, cwd || process.cwd());
    if (!server) {
      return NextResponse.json({ definitions: [] });
    }

    // 确保文件已打开
    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      return NextResponse.json({ error: 'Cannot read file' }, { status: 400 });
    }

    const definitions = await server.adapter.definition(absPath, line, column);
    return NextResponse.json({ definitions });
  } catch (error) {
    console.error('[lsp/definition] error:', error);
    return NextResponse.json({ error: 'LSP definition failed' }, { status: 500 });
  }
}
