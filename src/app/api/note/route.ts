import { readFile, writeFile } from 'fs/promises';
import { COCKPIT_DIR, NOTE_FILE, ensureDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET - 读取笔记内容
export async function GET() {
  try {
    await ensureDir(COCKPIT_DIR);
    const content = await readFile(NOTE_FILE, 'utf-8').catch(() => '');
    return Response.json({ content });
  } catch {
    return Response.json({ content: '' });
  }
}

// POST - 保存笔记内容
export async function POST(request: Request) {
  try {
    const { content } = await request.json();
    await ensureDir(COCKPIT_DIR);
    await writeFile(NOTE_FILE, content ?? '', 'utf-8');
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: 'Failed to save note' }, { status: 500 });
  }
}
