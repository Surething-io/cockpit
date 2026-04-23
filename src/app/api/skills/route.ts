import { NextRequest, NextResponse } from 'next/server';
import { SKILLS_FILE, readJsonFile, writeJsonFile, withFileLock } from '@/lib/paths';
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

function makeId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * GET /api/skills
 * Returns the user's registered skills with parsed metadata.
 */
export async function GET() {
  try {
    const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT);
    const enriched = await Promise.all(
      (data.skills || []).map(async (s) => {
        const parsed = await parseSkillMd(s.path);
        return {
          id: s.id,
          path: s.path,
          addedAt: s.addedAt,
          name: parsed.name,
          description: parsed.description,
          icon: parsed.icon,
          argumentHint: parsed.argumentHint,
          valid: parsed.valid,
        };
      })
    );
    return NextResponse.json(enriched);
  } catch (error) {
    console.error('Failed to list skills:', error);
    return NextResponse.json([], { status: 200 });
  }
}

/**
 * POST /api/skills  body: { path: string }
 * Adds a skill entry. Validates the file exists and is parseable.
 */
export async function POST(request: NextRequest) {
  try {
    const { path: absPath } = await request.json();
    if (typeof absPath !== 'string' || !absPath.trim()) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const trimmed = absPath.trim();
    if (!trimmed.startsWith('/')) {
      return NextResponse.json({ error: 'Absolute path required' }, { status: 400 });
    }

    const parsed = await parseSkillMd(trimmed);
    if (!parsed.valid) {
      return NextResponse.json({ error: 'File does not exist or cannot be read' }, { status: 400 });
    }

    const record = await withFileLock(SKILLS_FILE, async () => {
      const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT);
      // De-dup by path
      const existing = data.skills.find((s) => s.path === trimmed);
      if (existing) return existing;
      const next: SkillRecord = {
        id: makeId(),
        path: trimmed,
        addedAt: new Date().toISOString(),
      };
      const updated: SkillsFile = { skills: [...data.skills, next] };
      await writeJsonFile(SKILLS_FILE, updated);
      return next;
    });

    return NextResponse.json({
      id: record.id,
      path: record.path,
      addedAt: record.addedAt,
      name: parsed.name,
      description: parsed.description,
      icon: parsed.icon,
      argumentHint: parsed.argumentHint,
      valid: true,
    });
  } catch (error) {
    console.error('Failed to add skill:', error);
    return NextResponse.json({ error: 'Failed to add skill' }, { status: 500 });
  }
}
