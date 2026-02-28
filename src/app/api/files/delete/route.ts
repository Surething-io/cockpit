import { NextRequest, NextResponse } from 'next/server';
import { rm, stat } from 'fs/promises';
import { join, resolve } from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath } = body;

    if (!cwd || !filePath) {
      return NextResponse.json({ error: 'Missing cwd or path' }, { status: 400 });
    }

    const basePath = resolve(cwd);
    const fullPath = resolve(join(basePath, filePath));

    // 安全检查：路径必须在 cwd 内，不能删 cwd 本身
    if (!fullPath.startsWith(basePath + '/')) {
      return NextResponse.json({ error: '不允许删除此路径' }, { status: 403 });
    }

    const info = await stat(fullPath);
    await rm(fullPath, { recursive: info.isDirectory(), force: true });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
