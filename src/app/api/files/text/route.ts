import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import {
  resolveSafePath,
  statWithSymlink,
  classify,
  computeETag,
  isBinaryContent,
  MAX_TEXT_SIZE,
} from '@/lib/files/shared';

/**
 * GET /api/files/text?cwd=...&path=...
 *
 * Reads a file as utf-8 text. Returns the canonical text-content envelope
 * used by editors / search / diff / comments. Always sets `Cache-Control:
 * no-cache` so callers do not see stale content after a write.
 *
 * Status codes:
 *   200 — { content, size, mtimeMs, etag, isSymlink?, symlinkTarget? }
 *   400 — missing path
 *   403 — path escapes cwd
 *   404 — file not found
 *   409 — path is a directory, OR file is image/binary (caller should use /read)
 *   413 — file exceeds MAX_TEXT_SIZE
 *   500 — I/O error
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
    if (info.isDirectory) {
      return NextResponse.json({ error: 'Path is a directory' }, { status: 409 });
    }

    const ext = path.extname(filePath).toLowerCase();
    const category = classify(ext, info.size);

    // Hard refusals: this endpoint exists for text only.
    if (category === 'image' || category === 'binary') {
      return NextResponse.json(
        { error: `Not a text file (category: ${category})`, category },
        { status: 409 },
      );
    }
    if (category === 'too-large' || info.size > MAX_TEXT_SIZE) {
      return NextResponse.json(
        {
          error: `File too large (over ${Math.floor(MAX_TEXT_SIZE / 1024 / 1024)}MB)`,
          size: info.size,
        },
        { status: 413 },
      );
    }

    const content = await readFile(fullPath, 'utf-8');

    // Re-check after read: even an unknown ext could turn out to be binary.
    if (isBinaryContent(content)) {
      return NextResponse.json(
        { error: 'File appears to be binary', category: 'binary' },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        content,
        size: info.size,
        mtimeMs: info.mtimeMs,
        etag: computeETag(info.size, info.mtimeMs),
        ...(info.isSymlink ? { isSymlink: true, symlinkTarget: info.symlinkTarget } : {}),
      },
      { headers: { 'Cache-Control': 'no-cache' } },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    console.error('Error reading text file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
