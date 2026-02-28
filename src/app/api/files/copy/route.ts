import { NextRequest, NextResponse } from 'next/server';
import { copyFile, stat } from 'fs/promises';
import { join, resolve, dirname, basename, extname } from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath } = body;

    if (!cwd || !filePath) {
      return NextResponse.json({ error: 'Missing cwd or path' }, { status: 400 });
    }

    const basePath = resolve(cwd);
    const fullPath = resolve(join(basePath, filePath));

    // 安全检查
    if (!fullPath.startsWith(basePath + '/')) {
      return NextResponse.json({ error: '不允许操作此路径' }, { status: 403 });
    }

    // 生成目标文件名: file.ts → file-copy.ts, file-copy.ts → file-copy-2.ts
    const dir = dirname(fullPath);
    const ext = extname(fullPath);
    const base = basename(fullPath, ext);

    let destName: string;
    let destPath: string;
    let counter = 1;

    // 第一次尝试 file-copy.ext
    destName = `${base}-copy${ext}`;
    destPath = join(dir, destName);

    try {
      await stat(destPath);
      // 已存在，尝试 file-copy-2.ext, file-copy-3.ext...
      counter = 2;
      while (true) {
        destName = `${base}-copy-${counter}${ext}`;
        destPath = join(dir, destName);
        try {
          await stat(destPath);
          counter++;
        } catch {
          break; // 文件不存在，可用
        }
      }
    } catch {
      // file-copy.ext 不存在，直接用
    }

    await copyFile(fullPath, destPath);

    // 返回相对路径
    const relDir = dirname(filePath);
    const newRelPath = relDir === '.' ? destName : `${relDir}/${destName}`;

    return NextResponse.json({ success: true, newPath: newRelPath });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
