import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { homedir } from 'os';

/**
 * GET /api/pick-folder
 * 调用 macOS 原生文件夹选择对话框，默认打开 home 目录，返回选中的绝对路径
 */
export async function GET() {
  try {
    const home = homedir();
    const script = `osascript -e 'POSIX path of (choose folder with prompt "选择项目文件夹" default location POSIX file "${home}")'`;
    const result = execSync(script, { encoding: 'utf8', timeout: 60000 }).trim();

    if (result) {
      // osascript 返回的路径末尾有 /，去掉
      const folder = result.replace(/\/$/, '');
      return NextResponse.json({ folder });
    }

    return NextResponse.json({ folder: null });
  } catch {
    // 用户点了取消，osascript 返回非 0 退出码
    return NextResponse.json({ folder: null });
  }
}
