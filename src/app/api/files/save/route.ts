import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath, content, createDir } = body;

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

    // Ensure directory exists
    const dir = dirname(fullPath);
    await mkdir(dir, { recursive: true });

    // Write file
    await writeFile(fullPath, content, 'utf-8');

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving file:', error);
    return NextResponse.json(
      { error: 'Failed to save file' },
      { status: 500 }
    );
  }
}
