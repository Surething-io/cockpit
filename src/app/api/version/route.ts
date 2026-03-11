import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function GET() {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    return NextResponse.json({ version: pkg.version });
  } catch {
    return NextResponse.json({ version: '' });
  }
}
