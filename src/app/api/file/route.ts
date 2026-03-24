import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  const raw = searchParams.get('raw') === 'true';

  try {
    // Safety check: ensure path is absolute
    const absolutePath = path.resolve(filePath);

    // Check if file exists
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }

    // Check file size, limit to 10MB
    const maxSize = 10 * 1024 * 1024;
    if (stat.size > maxSize) {
      return NextResponse.json({
        error: `File too large (${(stat.size / 1024 / 1024).toFixed(2)}MB). Max size is 10MB.`
      }, { status: 400 });
    }

    // raw mode: return binary file directly (for images, etc.)
    if (raw) {
      const buffer = await fs.readFile(absolutePath);
      const ext = path.extname(absolutePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.avif': 'image/avif',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      return new NextResponse(buffer, {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
      });
    }

    // Read file content
    const content = await fs.readFile(absolutePath, 'utf-8');

    return NextResponse.json({
      content,
      path: absolutePath,
      size: stat.size,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    console.error('Error reading file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
