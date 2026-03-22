import { NextRequest, NextResponse } from 'next/server';
import { stat } from 'fs/promises';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * POST /api/files/clipboard — 将文件引用写入系统剪贴板（macOS）
 * VSCode / Finder 可直接粘贴
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath } = body;

    if (!cwd || !filePath) {
      return NextResponse.json({ error: 'Missing cwd or path' }, { status: 400 });
    }

    const basePath = resolve(cwd);
    const fullPath = resolve(join(basePath, filePath));

    if (!fullPath.startsWith(basePath + '/')) {
      return NextResponse.json({ error: '不允许操作此路径' }, { status: 403 });
    }

    await stat(fullPath);

    if (process.platform === 'darwin') {
      await execFileAsync('osascript', [
        '-e',
        `set the clipboard to POSIX file "${fullPath}"`,
      ]);
    } else {
      // 非 macOS：复制绝对路径为文本
      await execFileAsync('xclip', ['-selection', 'clipboard'], { input: fullPath } as never);
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/files/clipboard — 从系统剪贴板读取文件路径
 */
export async function GET() {
  try {
    if (process.platform !== 'darwin') {
      return NextResponse.json({ path: null });
    }

    // 尝试读取剪贴板中的文件引用
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'POSIX path of (the clipboard as «class furl»)',
      ]);
      const clipPath = stdout.trim().replace(/\/$/, ''); // 去掉尾部斜杠
      if (clipPath) {
        // 验证文件存在
        await stat(clipPath);
        return NextResponse.json({ path: clipPath });
      }
    } catch {
      // 剪贴板不是文件引用，忽略
    }

    return NextResponse.json({ path: null });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
