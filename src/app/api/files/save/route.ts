import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, stat, lstat, realpath, rename, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath, content, createDir, expectedMtime } = body;

    if (!filePath) {
      return NextResponse.json(
        { error: 'File path is required' },
        { status: 400 }
      );
    }

    const basePath = cwd || process.cwd();
    const fullPath = join(basePath, filePath);

    // 如果是创建文件夹
    if (createDir) {
      await mkdir(fullPath, { recursive: true });
      return NextResponse.json({ success: true });
    }

    // 创建文件
    if (content === undefined || content === null) {
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 }
      );
    }

    // P0: 冲突检测 — 保存前检查 mtime 是否一致
    if (expectedMtime !== undefined && expectedMtime !== null) {
      try {
        const currentStats = await stat(fullPath);
        const currentMtime = currentStats.mtimeMs;
        if (Math.abs(currentMtime - expectedMtime) > 1) {
          // 文件在编辑期间被外部修改
          return NextResponse.json({
            success: false,
            conflict: true,
            currentMtime,
            expectedMtime,
            message: '文件已被外部修改',
          }, { status: 409 });
        }
      } catch {
        // 文件不存在（可能被删除），允许继续创建
      }
    }

    // P2: Symlink 保护 — 如果是符号链接，写入真实目标文件
    let writePath = fullPath;
    try {
      const lstats = await lstat(fullPath);
      if (lstats.isSymbolicLink()) {
        writePath = await realpath(fullPath);
      }
    } catch {
      // 文件不存在，正常创建
    }

    // Ensure directory exists
    const dir = dirname(writePath);
    await mkdir(dir, { recursive: true });

    // P1: 原子写入 — 先写临时文件，再 rename
    const tmpPath = `${writePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, writePath);
    } catch (error) {
      // 清理临时文件
      try { await unlink(tmpPath); } catch { /* ignore */ }
      throw error;
    }

    // 返回新的 mtime
    const newStats = await stat(fullPath);
    return NextResponse.json({
      success: true,
      mtime: newStats.mtimeMs,
    });
  } catch (error) {
    console.error('Error saving file:', error);
    return NextResponse.json(
      { error: 'Failed to save file' },
      { status: 500 }
    );
  }
}
