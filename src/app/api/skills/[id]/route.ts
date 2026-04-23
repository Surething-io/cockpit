import { NextRequest, NextResponse } from 'next/server';
import { SKILLS_FILE, readJsonFile, writeJsonFile, withFileLock } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SkillRecord {
  id: string;
  path: string;
  addedAt: string;
}

interface SkillsFile {
  skills: SkillRecord[];
}

const DEFAULT: SkillsFile = { skills: [] };

/**
 * DELETE /api/skills/:id
 * Remove a skill entry by id.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const ok = await withFileLock(SKILLS_FILE, async () => {
      const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT);
      const next = data.skills.filter((s) => s.id !== id);
      if (next.length === data.skills.length) return false;
      await writeJsonFile(SKILLS_FILE, { skills: next });
      return true;
    });

    if (!ok) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete skill:', error);
    return NextResponse.json({ error: 'Failed to delete skill' }, { status: 500 });
  }
}
