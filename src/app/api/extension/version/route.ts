import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function GET() {
  try {
    const extensionDir = join(process.cwd(), 'chrome-extension');
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
