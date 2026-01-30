import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export interface GitDiffResponse {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const file = searchParams.get('file');
  const type = searchParams.get('type') as 'staged' | 'unstaged';

  if (!file) {
    return NextResponse.json({ error: 'Missing file parameter' }, { status: 400 });
  }

  if (!type || !['staged', 'unstaged'].includes(type)) {
    return NextResponse.json({ error: 'Invalid type parameter. Must be "staged" or "unstaged"' }, { status: 400 });
  }

  try {
    const absolutePath = path.resolve(cwd, file);
    let oldContent = '';
    let newContent = '';
    let isNew = false;
    let isDeleted = false;

    if (type === 'staged') {
      // 暂存区: HEAD vs 暂存区
      // 获取 HEAD 版本
      try {
        const { stdout: headContent } = await execAsync(`git show HEAD:"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
        oldContent = headContent;
      } catch {
        // 文件是新增的，HEAD 中不存在
        isNew = true;
        oldContent = '';
      }

      // 获取暂存区版本
      try {
        const { stdout: stagedContent } = await execAsync(`git show :"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
        newContent = stagedContent;
      } catch {
        // 文件被删除
        isDeleted = true;
        newContent = '';
      }
    } else {
      // 工作区: 暂存区 vs 工作区 (若暂存区无则 HEAD vs 工作区)
      // 先尝试获取暂存区版本
      try {
        const { stdout: stagedContent } = await execAsync(`git show :"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
        oldContent = stagedContent;
      } catch {
        // 暂存区没有，尝试获取 HEAD 版本
        try {
          const { stdout: headContent } = await execAsync(`git show HEAD:"${file}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
          oldContent = headContent;
        } catch {
          // 都没有，说明是新文件
          isNew = true;
          oldContent = '';
        }
      }

      // 获取工作区版本（当前文件内容）
      try {
        newContent = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // 文件被删除
        isDeleted = true;
        newContent = '';
      }
    }

    return NextResponse.json({
      oldContent,
      newContent,
      filePath: file,
      isNew,
      isDeleted,
    } as GitDiffResponse);
  } catch (error) {
    console.error('Error getting git diff:', error);
    return NextResponse.json({ error: 'Failed to get git diff' }, { status: 500 });
  }
}
