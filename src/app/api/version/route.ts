import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

export async function GET() {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    let version = pkg.version;
    // dev 环境下动态计算 commit 数
    if (process.env.COCKPIT_ENV === 'dev') {
      try {
        const count = execSync('git rev-list --count HEAD', { cwd: process.cwd() }).toString().trim();
        version = `1.0.${count}`;
      } catch { /* git 不可用时 fallback 到 package.json */ }
    }
    return NextResponse.json({ version });
  } catch {
    return NextResponse.json({ version: '' });
  }
}
