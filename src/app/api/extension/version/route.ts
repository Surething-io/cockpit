import { NextResponse } from 'next/server';
import { readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

/** 获取目录下所有文件的最新修改时间，格式 YYYY-MM-DD HH:mm:ss */
function getLatestMtime(dir: string): string {
  let latest = 0;
  const scan = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else {
        const mt = statSync(full).mtimeMs;
        if (mt > latest) latest = mt;
      }
    }
  };
  scan(dir);
  const d = new Date(latest);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function GET() {
  try {
    const extensionDir = join(process.cwd(), 'chrome-extension');
    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const updatedAt = getLatestMtime(extensionDir);
    return NextResponse.json({
      version: manifest.version,
      name: manifest.name,
      path: extensionDir,
      updatedAt,
    });
  } catch {
    return NextResponse.json({ error: 'manifest not found' }, { status: 404 });
  }
}
