import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { getLanguageForFile } from '@/lib/lsp/types';
import { getOrCreateServer, ensureFileOpen } from '@/lib/lsp/LSPServerRegistry';

/**
 * Warm up LSP: start the Language Server for the given language and open the file
 * Called by the frontend when a TS/JS/PY file is selected; does not block the UI
 */
export async function POST(request: NextRequest) {
  try {
    const { cwd, filePath } = await request.json();
    if (!filePath) {
      return NextResponse.json({ ok: false });
    }

    const language = getLanguageForFile(filePath);
    if (!language) {
      return NextResponse.json({ ok: false });
    }

    const server = await getOrCreateServer(language, cwd || process.cwd());
    if (!server) {
      return NextResponse.json({ ok: false });
    }

    // Pre-open the file so subsequent hover/definition requests don't need to wait for open
    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      // File is not readable, ignore
    }

    return NextResponse.json({ ok: true, language, pid: server.process.pid });
  } catch (error) {
    console.error('[lsp/warmup] error:', error);
    return NextResponse.json({ ok: false });
  }
}
