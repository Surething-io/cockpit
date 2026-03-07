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
    // 安全检查：确保路径是绝对路径
    const absolutePath = path.resolve(filePath);

    // 检查文件是否存在
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }

    // 检查文件大小，限制为 10MB
    const maxSize = 10 * 1024 * 1024;
    if (stat.size > maxSize) {
      return NextResponse.json({
        error: `File too large (${(stat.size / 1024 / 1024).toFixed(2)}MB). Max size is 10MB.`
      }, { status: 400 });
    }

    // raw 模式：直接返回二进制文件（用于图片等）
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

    // 读取文件内容
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
