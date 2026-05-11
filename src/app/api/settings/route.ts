import { SETTINGS_FILE, readJsonFile, writeJsonFile } from '@cockpit/shared-utils';

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
  return Response.json(settings);
}

/**
 * PUT /api/settings
 * Merge-update global settings to ~/.cockpit/settings.json
 */
export async function PUT(request: Request) {
  const body = await request.json() as Partial<Settings>;
  const current = await readJsonFile<Settings>(SETTINGS_FILE, {});
  const merged = { ...current, ...body };
  await writeJsonFile(SETTINGS_FILE, merged);
  return Response.json(merged);
}
