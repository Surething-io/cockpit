import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export async function GET() {
  try {
    // 优先用户目录（cock extension 安装的位置），fallback 到项目目录
    const userDir = join(homedir(), '.cockpit', 'chrome-extension');
    const projectDir = join(process.cwd(), 'chrome-extension');
    const extensionDir = existsSync(join(userDir, 'manifest.json')) ? userDir : projectDir;

    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return NextResponse.json({
      version: manifest.version,
      name: manifest.name,
      path: extensionDir,
    });
  } catch {
    return NextResponse.json({ error: 'manifest not found' }, { status: 404 });
  }
}
