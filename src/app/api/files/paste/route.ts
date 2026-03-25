import { NextRequest, NextResponse } from 'next/server';
import { stat, cp } from 'fs/promises';
import { join, resolve, basename, extname } from 'path';

/**
 * Generate a non-conflicting destination name.
 * file.ts → file copy.ts → file copy 2.ts → ...
 * dir → dir copy → dir copy 2 → ...
 */
async function getUniqueName(targetDir: string, originalName: string): Promise<string> {
  const ext = extname(originalName);
  const base = basename(originalName, ext);

  // Check if original name conflicts first
  try {
    await stat(join(targetDir, originalName));
  } catch {
    return originalName; // Does not exist, use directly
  }

  // Conflict found, try "file copy.ext"
  let candidate = `${base} copy${ext}`;
  try {
    await stat(join(targetDir, candidate));
  } catch {
    return candidate;
  }

  // Continue trying "file copy 2.ext", "file copy 3.ext", ...
  let counter = 2;
  while (counter < 100) {
    candidate = `${base} copy ${counter}${ext}`;
    try {
      await stat(join(targetDir, candidate));
      counter++;
    } catch {
      return candidate;
    }
  }

  throw new Error('Failed to generate a unique filename');
}

/**
 * POST /api/files/paste
 * body: { cwd, targetDir, sourceAbsPath }
 * - sourceAbsPath: absolute path of source file (obtained from system clipboard)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, targetDir, sourceAbsPath } = body;

    if (!cwd || targetDir == null || !sourceAbsPath) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const basePath = resolve(cwd);
    const targetAbsDir = resolve(join(basePath, targetDir));

    if (!targetAbsDir.startsWith(basePath)) {
      return NextResponse.json({ error: 'Operation not allowed on this path' }, { status: 403 });
    }

    const srcAbsPath = resolve(sourceAbsPath);

    // Verify source file exists
    const srcStat = await stat(srcAbsPath);

    // Verify target directory exists
    const targetStat = await stat(targetAbsDir);
    if (!targetStat.isDirectory()) {
      return NextResponse.json({ error: 'Target is not a folder' }, { status: 400 });
    }

    // Generate non-conflicting filename
    const srcName = basename(srcAbsPath);
    const destName = await getUniqueName(targetAbsDir, srcName);
    const destPath = join(targetAbsDir, destName);

    // Copy (recursive, supports folders)
    await cp(srcAbsPath, destPath, { recursive: srcStat.isDirectory() });

    // Return relative path of the new file
    const relPath = targetDir ? `${targetDir}/${destName}` : destName;

    return NextResponse.json({ success: true, newPath: relPath, newName: destName });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
