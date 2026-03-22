import { NextRequest, NextResponse } from 'next/server';
import { stat } from 'fs/promises';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * macOS: 通过 osascript 将文件/文件夹移动到回收站
 * 其他平台: fallback 到 rm
 */
async function moveToTrash(fullPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    // osascript 调用 Finder 的 delete 命令（移动到回收站）
    await execFileAsync('osascript', [
      '-e',
      `tell application "Finder" to delete (POSIX file "${fullPath}" as alias)`,
    ]);
  } else {
    // 非 macOS 平台 fallback 到永久删除
    const { rm } = await import('fs/promises');
    const info = await stat(fullPath);
    await rm(fullPath, { recursive: info.isDirectory(), force: true });
  }
}

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

    // 验证文件/目录存在
    await stat(fullPath);

    await moveToTrash(fullPath);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
