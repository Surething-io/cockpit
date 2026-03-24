import { readFile, writeFile } from 'fs/promises';
import { COCKPIT_DIR, NOTE_FILE, ensureDir, getProjectNotePath, getCockpitProjectDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve the note file path
 * - With cwd param: project-level note ~/.cockpit/projects/<encoded-cwd>/note.md
 * - Without cwd param: global note ~/.cockpit/note.md
 */
function getNotePaths(url: string) {
  const { searchParams } = new URL(url);
  const cwd = searchParams.get('cwd');
  if (cwd) {
    return { filePath: getProjectNotePath(cwd), dir: getCockpitProjectDir(cwd) };
  }
  return { filePath: NOTE_FILE, dir: COCKPIT_DIR };
}

// GET - Read note content
export async function GET(request: Request) {
  try {
    const { filePath, dir } = getNotePaths(request.url);
    await ensureDir(dir);
    const content = await readFile(filePath, 'utf-8').catch(() => '');
    return Response.json({ content });
  } catch {
    return Response.json({ content: '' });
  }
}

// POST - Save note content
export async function POST(request: Request) {
  try {
    const { filePath, dir } = getNotePaths(request.url);
    const { content } = await request.json();
    await ensureDir(dir);
    await writeFile(filePath, content ?? '', 'utf-8');
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: 'Failed to save note' }, { status: 500 });
  }
}
