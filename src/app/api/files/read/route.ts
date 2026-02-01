import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// Image extensions that can be previewed
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);

// Binary file extensions (non-text, non-image)
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.class', '.o', '.a',
]);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const filePath = searchParams.get('path');
  const raw = searchParams.get('raw') === '1';

  if (!filePath) {
    return NextResponse.json(
      { error: 'File path is required' },
      { status: 400 }
    );
  }

  try {
    const fullPath = join(cwd, filePath);
    const ext = extname(filePath).toLowerCase();

    // Get file stats
    const stats = await stat(fullPath);

    if (stats.isDirectory()) {
      return NextResponse.json(
        { error: 'Path is a directory' },
        { status: 400 }
      );
    }

    const fileSize = stats.size;

    // Check if it's an image
    if (IMAGE_EXTENSIONS.has(ext)) {
      // For images, return base64 encoded content
      if (fileSize > MAX_FILE_SIZE * 5) { // Allow larger images up to 5MB
        if (raw) {
          return new NextResponse('Image file too large', { status: 413 });
        }
        return NextResponse.json({
          type: 'error',
          message: '图片文件过大，无法预览',
          size: fileSize,
        });
      }

      const content = await readFile(fullPath);
      const mimeType = getMimeType(ext);

      // If raw=1, return raw image data for <img src="..."> usage
      if (raw) {
        return new NextResponse(content, {
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(fileSize),
          },
        });
      }

      const base64 = content.toString('base64');
      return NextResponse.json({
        type: 'image',
        content: `data:${mimeType};base64,${base64}`,
        size: fileSize,
      });
    }

    // Check if it's a binary file
    if (BINARY_EXTENSIONS.has(ext)) {
      return NextResponse.json({
        type: 'binary',
        message: '无法预览二进制文件',
        size: fileSize,
      });
    }

    // Check file size for text files
    if (fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({
        type: 'error',
        message: '文件过大，无法预览（超过 1MB）',
        size: fileSize,
      });
    }

    // Read as text
    const content = await readFile(fullPath, 'utf-8');

    // Check if content looks like binary
    if (isBinaryContent(content)) {
      return NextResponse.json({
        type: 'binary',
        message: '无法预览二进制文件',
        size: fileSize,
      });
    }

    return NextResponse.json({
      type: 'text',
      content,
      size: fileSize,
    });
  } catch (error) {
    console.error('Error reading file:', error);
    return NextResponse.json(
      { error: 'Failed to read file' },
      { status: 500 }
    );
  }
}

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function isBinaryContent(content: string): boolean {
  // Check for null bytes or high ratio of non-printable characters
  let nonPrintable = 0;
  const sampleSize = Math.min(content.length, 1000);

  for (let i = 0; i < sampleSize; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) return true; // Null byte = definitely binary
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }

  return nonPrintable / sampleSize > 0.1; // More than 10% non-printable = likely binary
}
