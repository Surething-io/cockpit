import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { getLanguageForFile } from '@/lib/lsp/types';
import { getOrCreateServer, ensureFileOpen } from '@/lib/lsp/LSPServerRegistry';

/**
 * 预热 LSP：启动对应语言的 Language Server 并打开文件
 * 前端在选中 TS/JS/PY 文件时调用，不阻塞 UI
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

    // 预先打开文件，后续 hover/definition 就不用等 open
    const absPath = resolve(cwd || process.cwd(), filePath);
    try {
      const content = await readFile(absPath, 'utf-8');
      await ensureFileOpen(server, absPath, content);
    } catch {
      // 文件不可读，忽略
    }

    return NextResponse.json({ ok: true, language, pid: server.process.pid });
  } catch (error) {
    console.error('[lsp/warmup] error:', error);
    return NextResponse.json({ ok: false });
  }
}
