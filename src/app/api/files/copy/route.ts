import { NextRequest, NextResponse } from 'next/server';
import { copyFile, stat } from 'fs/promises';
import { join, resolve, dirname, basename, extname } from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath } = body;

    if (!cwd || !filePath) {
      return NextResponse.json({ error: 'Missing cwd or path' }, { status: 400 });
    }

    const basePath = resolve(cwd);
    const fullPath = resolve(join(basePath, filePath));

    // Safety check
    if (!fullPath.startsWith(basePath + '/')) {
      return NextResponse.json({ error: 'Operation not allowed on this path' }, { status: 403 });
    }

    // Generate destination filename: file.ts → file-copy.ts, file-copy.ts → file-copy-2.ts
    const dir = dirname(fullPath);
    const ext = extname(fullPath);
    const base = basename(fullPath, ext);

    let destName: string;
    let destPath: string;
    let counter = 1;

    // First attempt: file-copy.ext
    destName = `${base}-copy${ext}`;
    destPath = join(dir, destName);

    try {
      await stat(destPath);
      // Already exists, try file-copy-2.ext, file-copy-3.ext...
      counter = 2;
      while (true) {
        destName = `${base}-copy-${counter}${ext}`;
        destPath = join(dir, destName);
        try {
          await stat(destPath);
          counter++;
        } catch {
          break; // File does not exist, use it
        }
      }
    } catch {
      // file-copy.ext does not exist, use it directly
    }

    await copyFile(fullPath, destPath);

    // Return relative path
    const relDir = dirname(filePath);
    const newRelPath = relDir === '.' ? destName : `${relDir}/${destName}`;

    return NextResponse.json({ success: true, newPath: newRelPath });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
