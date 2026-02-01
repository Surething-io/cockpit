import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

const execAsync = promisify(exec);

export interface SyncCheckResponse {
  changed: boolean;
  fingerprint: string;
}

/**
 * 生成 Git 仓库的指纹
 * 指纹由以下内容组成：
 * 1. HEAD commit hash
 * 2. git status --porcelain 输出（包含所有未提交的变更）
 *
 * 如果指纹相同，说明：
 * - 没有新的 commit
 * - 没有文件被修改/添加/删除
 */
async function getGitFingerprint(cwd: string): Promise<string> {
  try {
    // 获取 HEAD hash 和 status 输出
    const [headResult, statusResult] = await Promise.all([
      execAsync('git rev-parse HEAD', { cwd }).catch(() => ({ stdout: '' })),
      execAsync('git status --porcelain -u', { cwd }).catch(() => ({ stdout: '' })),
    ]);

    const combined = `${headResult.stdout.trim()}\n${statusResult.stdout}`;

    // 使用 MD5 生成指纹（足够用于比较，且短小）
    return createHash('md5').update(combined).digest('hex');
  } catch {
    // 非 Git 仓库，使用时间戳作为指纹（每次都不同，强制刷新）
    return Date.now().toString();
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const since = searchParams.get('since') || '';

  try {
    const fingerprint = await getGitFingerprint(cwd);

    // 比较指纹
    const changed = fingerprint !== since;

    return NextResponse.json({
      changed,
      fingerprint,
    } as SyncCheckResponse);
  } catch (error) {
    console.error('Error checking sync status:', error);
    // 出错时返回 changed: true，让前端刷新
    return NextResponse.json({
      changed: true,
      fingerprint: Date.now().toString(),
    } as SyncCheckResponse);
  }
}
