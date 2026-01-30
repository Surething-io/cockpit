import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitStageRequest {
  cwd?: string;
  files: string[]; // 文件路径列表，支持单个或多个
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as GitStageRequest;
    const { cwd = process.cwd(), files } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid files parameter' }, { status: 400 });
    }

    // 检查是否是 git 仓库
    await execAsync('git rev-parse --git-dir', { cwd });

    // 转义文件路径，处理空格和特殊字符
    const escapedFiles = files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');

    // 执行 git add
    await execAsync(`git add ${escapedFiles}`, { cwd });

    return NextResponse.json({
      success: true,
      files,
      message: `Staged ${files.length} file(s)`,
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.message?.includes('not a git repository')) {
      return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
    }
    console.error('Error staging files:', error);
    return NextResponse.json({ error: 'Failed to stage files' }, { status: 500 });
  }
}
