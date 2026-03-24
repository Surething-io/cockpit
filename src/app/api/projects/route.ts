import { COCKPIT_DIR, readJsonFile, writeJsonFile } from '@/lib/paths';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECTS_FILE = join(COCKPIT_DIR, 'projects.json');

export interface ProjectInfo {
  cwd: string;
  sessionId?: string;
}

export interface ProjectsData {
  projects: ProjectInfo[];
  activeIndex: number;
  collapsed: boolean;
}

const DEFAULT_DATA: ProjectsData = {
  projects: [],
  activeIndex: 0,
  collapsed: false,
};

// GET - Read project list
export async function GET() {
  try {
    const data = await readJsonFile<ProjectsData>(PROJECTS_FILE, DEFAULT_DATA);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Projects API GET error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST - Save project list
export async function POST(request: Request) {
  try {
    const data = await request.json() as ProjectsData;
    await writeJsonFile(PROJECTS_FILE, data);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Projects API POST error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
