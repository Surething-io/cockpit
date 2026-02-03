import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const cwd = searchParams.get('cwd');

    if (!cwd) {
      return NextResponse.json(
        { error: 'Missing cwd' },
        { status: 400 }
      );
    }

    const packageJsonPath = join(cwd, 'package.json');

    if (!existsSync(packageJsonPath)) {
      return NextResponse.json({ scripts: {} });
    }

    const content = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);
    const scripts = packageJson.scripts || {};

    return NextResponse.json({ scripts });
  } catch (error) {
    console.error('Failed to read package.json:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read package.json' },
      { status: 500 }
    );
  }
}
