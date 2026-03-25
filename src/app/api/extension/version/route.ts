import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export async function GET() {
  try {
    // npm 安装: 无 src/ 目录，extension 在 ~/.cockpit/chrome-extension/
    // 源码 link: 有 src/ 目录，extension 在 {cwd}/chrome-extension/
    const isNpmInstall = !existsSync(join(process.cwd(), 'src'));
    const extensionDir = isNpmInstall
      ? join(homedir(), '.cockpit', 'chrome-extension')
      : join(process.cwd(), 'chrome-extension');

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
