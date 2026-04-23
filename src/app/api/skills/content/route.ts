import { NextRequest, NextResponse } from 'next/server';
import { SKILLS_FILE, readJsonFile } from '@/lib/paths';
import { parseSkillMd } from '@/lib/skills/parseSkillMd';

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
 * GET /api/skills/content?id=xxx
 * Return the raw SKILL.md content (plus parsed metadata) for preview.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT);
    const record = data.skills.find((s) => s.id === id);
    if (!record) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const parsed = await parseSkillMd(record.path);
    return NextResponse.json({
      id: record.id,
      path: record.path,
      name: parsed.name,
      description: parsed.description,
      icon: parsed.icon,
      argumentHint: parsed.argumentHint,
      valid: parsed.valid,
      content: parsed.content,
    });
  } catch (error) {
    console.error('Failed to load skill content:', error);
    return NextResponse.json({ error: 'Failed to load content' }, { status: 500 });
  }
}
