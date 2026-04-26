import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import {
  resolveSafePath,
  statWithSymlink,
  classify,
  computeETag,
  getMimeType,
  type FileCategory,
} from '@/lib/files/shared';

/**
 * GET /api/files/stat?cwd=...&path=...
 *
 * Returns lightweight metadata for a single path. Never reads file bytes,
 * so it is safe to call freely (tooltips, list rendering, pre-flight before
 * a heavier `/read` or `/text`).
 *
 * Response (200):
 *   {
 *     exists: true,
 *     kind: 'file' | 'dir' | 'symlink',
 *     size, mtimeMs, isSymlink, symlinkTarget,
 *     category: 'image' | 'text' | 'binary' | 'too-large',
 *     mimeType, etag
 *   }
 *
 * Response (200, missing):  { exists: false }
 * Response (400/403/500):   { error }
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'File path is required' }, { status: 400 });
  }

  const fullPath = resolveSafePath(cwd, filePath);
  if (!fullPath) {
    return NextResponse.json({ error: 'Path escapes cwd' }, { status: 403 });
  }

  try {
    const info = await statWithSymlink(fullPath);
    const ext = path.extname(filePath).toLowerCase();

    let kind: 'file' | 'dir' | 'symlink' = 'file';
    if (info.isDirectory) kind = 'dir';
    else if (info.isSymlink) kind = 'symlink';

    let category: FileCategory | null = null;
    let mimeType: string | undefined;
    let etag: string | undefined;
    if (!info.isDirectory) {
      category = classify(ext, info.size);
      mimeType = category === 'image' ? getMimeType(ext) : undefined;
      etag = computeETag(info.size, info.mtimeMs);
    }

    return NextResponse.json(
      {
        exists: true,
        kind,
        size: info.size,
        mtimeMs: info.mtimeMs,
        isSymlink: info.isSymlink,
        symlinkTarget: info.symlinkTarget,
        category,
        mimeType,
        etag,
      },
      { headers: { 'Cache-Control': 'no-cache' } },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return NextResponse.json({ exists: false }, { headers: { 'Cache-Control': 'no-cache' } });
    }
    console.error('Error stat file:', error);
    return NextResponse.json({ error: 'Failed to stat file' }, { status: 500 });
  }
}
