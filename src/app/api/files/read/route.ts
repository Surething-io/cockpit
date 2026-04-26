import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import {
  resolveSafePath,
  statWithSymlink,
  classify,
  computeETag,
  buildCacheHeaders,
  ifNoneMatch,
  getMimeType,
  MAX_IMAGE_SIZE,
} from '@/lib/files/shared';

/**
 * GET /api/files/read
 *
 * Streams the raw bytes of a file. Designed for direct use in `<img src>` /
 * `<video src>` / `<a href>`, never wrapped in JSON, never base64-encoded.
 *
 * - Always sets `ETag` + `Last-Modified` + `Cache-Control: no-cache,
 *   must-revalidate`, so the browser revalidates via conditional GET on
 *   every access (304 when unchanged, fresh body when bytes change).
 * - Supports `Range` requests for large media.
 * - Streams from disk; never reads the full body into memory.
 *
 * Categories:
 *   - image  → 200 stream
 *   - text   → 409 (callers should use `/api/files/text` instead)
 *   - binary → 409 (no inline preview supported)
 *
 * Status codes:
 *   200, 206, 304, 400, 403, 404, 409, 413, 416, 500
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

    if (category === 'too-large') {
      return NextResponse.json(
        {
          error: `File too large (over ${Math.floor(MAX_IMAGE_SIZE / 1024 / 1024)}MB)`,
          size: info.size,
        },
        { status: 413 },
      );
    }
    if (category !== 'image') {
      return NextResponse.json(
        {
          error: `This endpoint streams images only (category: ${category}). Use /api/files/text for text.`,
          category,
        },
        { status: 409 },
      );
    }

    const etag = computeETag(info.size, info.mtimeMs);

    // Conditional GET — short-circuit when nothing changed.
    if (ifNoneMatch(request.headers.get('if-none-match'), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: buildCacheHeaders(etag, info.mtimeMs),
      });
    }

    const baseHeaders = {
      ...buildCacheHeaders(etag, info.mtimeMs),
      'Content-Type': getMimeType(ext),
      'Accept-Ranges': 'bytes',
    };

    // Range support for large media.
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : info.size - 1;
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start >= 0 &&
          end < info.size &&
          start <= end
        ) {
          const stream = createReadStream(fullPath, { start, end });
          return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
            status: 206,
            headers: {
              ...baseHeaders,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${info.size}`,
            },
          });
        }
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      }
    }

    // Full body, streamed from disk — large images never enter Node's heap.
    const stream = createReadStream(fullPath);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Length': String(info.size),
      },
    });
  } catch (error) {
    console.error('Error reading file:', error);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
