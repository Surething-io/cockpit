import { NextRequest, NextResponse } from 'next/server';
import { stat, cp } from 'fs/promises';
import { join, resolve, basename, extname } from 'path';

/**
 * 生成不冲突的目标名称
 * file.ts → file copy.ts → file copy 2.ts → ...
 * dir → dir copy → dir copy 2 → ...
 */
async function getUniqueName(targetDir: string, originalName: string): Promise<string> {
  const ext = extname(originalName);
  const base = basename(originalName, ext);

  // 先检查原名是否冲突
  try {
    await stat(join(targetDir, originalName));
  } catch {
    return originalName; // 不存在，直接用
  }

  // 有冲突，尝试 "file copy.ext"
  let candidate = `${base} copy${ext}`;
  try {
    await stat(join(targetDir, candidate));
  } catch {
    return candidate;
  }

  // 继续尝试 "file copy 2.ext", "file copy 3.ext", ...
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

  throw new Error('无法生成唯一文件名');
}

/**
 * POST /api/files/paste
 * body: { cwd, targetDir, sourceAbsPath }
 * - sourceAbsPath: 源文件的绝对路径（统一从系统剪贴板获取）
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
      return NextResponse.json({ error: '不允许操作此路径' }, { status: 403 });
    }

    const srcAbsPath = resolve(sourceAbsPath);

    // 验证源文件存在
    const srcStat = await stat(srcAbsPath);

    // 验证目标目录存在
    const targetStat = await stat(targetAbsDir);
    if (!targetStat.isDirectory()) {
      return NextResponse.json({ error: '目标不是文件夹' }, { status: 400 });
    }

    // 生成不冲突的文件名
    const srcName = basename(srcAbsPath);
    const destName = await getUniqueName(targetAbsDir, srcName);
    const destPath = join(targetAbsDir, destName);

    // 复制（递归支持文件夹）
    await cp(srcAbsPath, destPath, { recursive: srcStat.isDirectory() });

    // 返回新文件的相对路径
    const relPath = targetDir ? `${targetDir}/${destName}` : destName;

    return NextResponse.json({ success: true, newPath: relPath, newName: destName });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
