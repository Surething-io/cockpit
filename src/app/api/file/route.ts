import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import {
  classify,
  computeETag,
  buildCacheHeaders,
  ifNoneMatch,
  isBinaryContent,
  getMimeType,
  MAX_TEXT_SIZE,
  MAX_IMAGE_SIZE,
} from '@/lib/files/shared';

/**
 * GET /api/file?path=<absolute>[&raw=true]
 *
 * The "absolute path" sibling of /api/files/{stat,text,read}. Used by chat
 * tool-call previews where paths arrive already absolute (e.g., from a Read
 * or Edit tool result), so there is no project cwd to anchor against.
 *
 * Both branches share `src/lib/files/shared.ts` with the cwd-bound endpoints
 * — same MIME table, same ETag derivation, same binary-sniff heuristic, same
 * cache headers. There is no second source of truth.
 *
 * Modes:
 *   - default              → text JSON `{ content, size, mtimeMs, etag }`
 *   - `&raw=true`          → image binary stream (suitable for `<img src>`)
 *
 * Status codes: 200, 206, 304, 400, 403, 404, 409, 413, 416, 500
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path');
  const raw = searchParams.get('raw') === 'true';

  if (!filePath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }
  // Defensive: reject null bytes (path injection) and require absolute paths.
  if (filePath.includes('\0')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  const absolutePath = path.resolve(filePath);
  if (!path.isAbsolute(filePath)) {
    return NextResponse.json(
      { error: 'This endpoint requires an absolute path; use /api/files/* for cwd-relative reads' },
      { status: 400 },
    );
  }

  try {
    const stats = await stat(absolutePath);
    if (stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is a directory' }, { status: 409 });
    }
    if (!stats.isFile()) {
      return NextResponse.json({ error: 'Not a regular file' }, { status: 400 });
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const category = classify(ext, stats.size);
    const etag = computeETag(stats.size, stats.mtimeMs);

    // ---- Image stream ----
    if (raw) {
      if (category === 'too-large') {
        return NextResponse.json(
          {
            error: `Image too large (over ${Math.floor(MAX_IMAGE_SIZE / 1024 / 1024)}MB)`,
            size: stats.size,
          },
          { status: 413 },
        );
      }
      if (category !== 'image') {
        return NextResponse.json(
          { error: `raw=true only supports image files (category: ${category})`, category },
          { status: 409 },
        );
      }

      if (ifNoneMatch(request.headers.get('if-none-match'), etag)) {
        return new NextResponse(null, {
          status: 304,
          headers: buildCacheHeaders(etag, stats.mtimeMs),
        });
      }

      const baseHeaders = {
        ...buildCacheHeaders(etag, stats.mtimeMs),
        'Content-Type': getMimeType(ext),
        'Accept-Ranges': 'bytes',
      };

      // Range support — same shape as /api/files/read.
      const range = request.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : stats.size - 1;
          if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            start >= 0 &&
            end < stats.size &&
            start <= end
          ) {
            const stream = createReadStream(absolutePath, { start, end });
            return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
              status: 206,
              headers: {
                ...baseHeaders,
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${stats.size}`,
              },
            });
          }
          return new NextResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${stats.size}` },
          });
        }
      }

      const stream = createReadStream(absolutePath);
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(stats.size) },
      });
    }

    // ---- Text JSON (default) ----
    if (category === 'image' || category === 'binary') {
      return NextResponse.json(
        { error: `Not a text file (category: ${category}). Use raw=true for images.`, category },
        { status: 409 },
      );
    }
    if (category === 'too-large' || stats.size > MAX_TEXT_SIZE) {
      return NextResponse.json(
        {
          error: `File too large (over ${Math.floor(MAX_TEXT_SIZE / 1024 / 1024)}MB)`,
          size: stats.size,
        },
        { status: 413 },
      );
    }

    const content = await readFile(absolutePath, 'utf-8');
    if (isBinaryContent(content)) {
      return NextResponse.json(
        { error: 'File appears to be binary', category: 'binary' },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        content,
        path: absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        etag,
      },
      { headers: { 'Cache-Control': 'no-cache' } },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if ((error as NodeJS.ErrnoException).code === 'EACCES') {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }
    console.error('Error reading file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
