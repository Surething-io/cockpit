import { NextRequest, NextResponse } from 'next/server';
import { SETTINGS_FILE, readJsonFile, writeJsonFile } from '@/lib/paths';

interface Settings {
  language?: string; // 'en' | 'zh' | 'auto'
  [key: string]: unknown;
}

/**
 * GET /api/settings
 * Read global settings from ~/.cockpit/settings.json
 */
export async function GET() {
  const settings = await readJsonFile<Settings>(SETTINGS_FILE, {});
  return NextResponse.json(settings);
}

/**
 * PUT /api/settings
 * Merge-update global settings to ~/.cockpit/settings.json
 */
export async function PUT(request: NextRequest) {
  const body = await request.json() as Partial<Settings>;
  const current = await readJsonFile<Settings>(SETTINGS_FILE, {});
  const merged = { ...current, ...body };
  await writeJsonFile(SETTINGS_FILE, merged);
  return NextResponse.json(merged);
}
