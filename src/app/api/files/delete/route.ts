import { NextRequest, NextResponse } from 'next/server';
import { stat, rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { isMac, isWindows } from '@/lib/platform';

const execFileAsync = promisify(execFile);

/**
 * 将文件/文件夹移动到回收站，各平台实现不同
 * 所有平台在回收站不可用时 fallback 到永久删除
 */
async function moveToTrash(fullPath: string): Promise<void> {
  if (isMac) {
    await execFileAsync('osascript', [
      '-e',
      `tell application "Finder" to delete (POSIX file "${fullPath}" as alias)`,
    ]);
  } else if (isWindows) {
    // PowerShell: 移动到回收站
    try {
      const escaped = fullPath.replace(/'/g, "''");
      execSync(`powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin')"`, { timeout: 10000 });
    } catch {
      // fallback: 永久删除
      const info = await stat(fullPath);
      await rm(fullPath, { recursive: info.isDirectory(), force: true });
    }
  } else {
    // Linux: gio trash，fallback rm
    try {
      execSync(`gio trash "${fullPath}"`, { timeout: 5000 });
    } catch {
      const info = await stat(fullPath);
      await rm(fullPath, { recursive: info.isDirectory(), force: true });
    }
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
    if (!fullPath.startsWith(basePath + sep)) {
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
