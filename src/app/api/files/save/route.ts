import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, stat, lstat, realpath, rename, unlink, chmod } from 'fs/promises';
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

    // If creating a directory
    if (createDir) {
      await mkdir(fullPath, { recursive: true });
      return NextResponse.json({ success: true });
    }

    // Create file
    if (content === undefined || content === null) {
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 }
      );
    }

    // P0: Conflict detection — check mtime consistency before saving
    if (expectedMtime !== undefined && expectedMtime !== null) {
      try {
        const currentStats = await stat(fullPath);
        const currentMtime = currentStats.mtimeMs;
        if (Math.abs(currentMtime - expectedMtime) > 1) {
          // File was modified externally during editing
          return NextResponse.json({
            success: false,
            conflict: true,
            currentMtime,
            expectedMtime,
            message: '文件已被外部修改',
          }, { status: 409 });
        }
      } catch {
        // File does not exist (possibly deleted), allow creation to proceed
      }
    }

    // P2: Symlink protection — if it is a symlink, write to the real target file
    let writePath = fullPath;
    try {
      const lstats = await lstat(fullPath);
      if (lstats.isSymbolicLink()) {
        writePath = await realpath(fullPath);
      }
    } catch {
      // File does not exist, create normally
    }

    // Ensure directory exists
    const dir = dirname(writePath);
    await mkdir(dir, { recursive: true });

    // Read original file permissions (to restore after writing)
    let originalMode: number | undefined;
    try {
      const st = await stat(writePath);
      originalMode = st.mode;
    } catch { /* New file, no permissions to preserve */ }

    // P1: Atomic write — write to temp file first, then rename
    const tmpPath = `${writePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, content, 'utf-8');
      // Restore original file permissions (writeFile defaults to 0o644, losing +x and other permissions)
      if (originalMode !== undefined) {
        await chmod(tmpPath, originalMode);
      }
      await rename(tmpPath, writePath);
    } catch (error) {
      // Clean up temp file
      try { await unlink(tmpPath); } catch { /* ignore */ }
      throw error;
    }

    // Return new mtime
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
